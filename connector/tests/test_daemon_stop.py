"""Shutdown races must not prevent remote revocation or mistake a live daemon for a stopped one."""
import json
import os
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agentrun_cli import cli, daemon
from agentrun_cli.state import State


class LocalSocket:
    def __init__(self, *, connect=None, receive=None):
        self.on_connect = connect
        self.on_receive = receive

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def settimeout(self, value):
        pass

    def connect(self, address):
        if self.on_connect:
            return self.on_connect(address)

    def sendall(self, value):
        if value != b"stop\n":
            raise AssertionError("Unexpected daemon control message")

    def recv(self, size):
        return self.on_receive(size) if self.on_receive else b"stopped\n"


class DaemonStop(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = State(Path(self.temp.name) / "state")
        self.state.data.update(connector_id="test-connector", workspace_id="local",
                               observing=True, credential="test-scoped-credential")
        self.state.save()
        self.fd = daemon.lock(self.state.directory)
        self.assertIsNotNone(self.fd)
        self.addCleanup(self.release_lock)

    def release_lock(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def socket_patch(self, client):
        # Replace only the daemon's Unix IPC boundary; network.request still uses real HTTP sockets.
        return patch.object(daemon, "socket", SimpleNamespace(AF_UNIX=socket.AF_UNIX, socket=lambda family: client))

    def test_stop_accepts_socket_disappearing_only_after_lock_released(self):
        def exited(address):
            self.release_lock()
            raise FileNotFoundError("daemon exited before connect")
        with self.socket_patch(LocalSocket(connect=exited)):
            self.assertEqual(daemon.stop(self.state), {"status": "stopped"})
        self.assertFalse(daemon.running(self.state.directory))

    def test_stop_accepts_eof_after_daemon_releases_its_lock(self):
        def exited(size):
            self.release_lock()
            return b""
        with self.socket_patch(LocalSocket(receive=exited)):
            self.assertEqual(daemon.stop(self.state), {"status": "stopped"})

    def test_stop_waits_for_lock_release_during_bounded_cleanup(self):
        def refused(address):
            raise ConnectionRefusedError("listener closed while cleanup is finishing")
        clock = SimpleNamespace(monotonic=iter([100.0, 100.01]).__next__,
                                sleep=lambda seconds: self.release_lock())
        with self.socket_patch(LocalSocket(connect=refused)), patch.object(daemon, "time", clock):
            self.assertEqual(daemon.stop(self.state), {"status": "stopped"})

    def test_stop_keeps_failure_when_daemon_lock_remains_held(self):
        def refused(address):
            raise ConnectionRefusedError("live daemon IPC unavailable")
        clock = SimpleNamespace(monotonic=iter([100.0, 130.0]).__next__,
                                sleep=lambda seconds: self.fail("Past the stop deadline"))
        with self.socket_patch(LocalSocket(connect=refused)), patch.object(daemon, "time", clock):
            with self.assertRaises(ConnectionRefusedError):
                daemon.stop(self.state)
        self.assertTrue(daemon.running(self.state.directory))

    def test_disconnect_revokes_on_first_attempt_when_daemon_exits_before_socket_connect(self):
        requests = []
        connector = {"id": "test-connector", "workspace_id": "local",
                     "selections_revision": 1, "selections": []}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_DELETE(self):
                requests.append((self.path, self.headers.get("Authorization")))
                payload = json.dumps(connector).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        origin = f"http://127.0.0.1:{server.server_port}"
        self.state.data["origin"] = origin
        self.state.save()

        def exited(address):
            saved = self.state.read()
            self.assertFalse(saved["observing"])
            self.assertTrue(saved["revocation_pending"])
            self.release_lock()
            raise FileNotFoundError("daemon noticed observing=false and exited")

        with self.socket_patch(LocalSocket(connect=exited)), patch.object(cli, "enrollment_credential", return_value="test-owner-credential"):
            result = cli.disconnect(SimpleNamespace(origin=origin), self.state)
        self.assertEqual(result, {"status": "disconnected"})
        self.assertEqual(requests, [("/api/v2/control/connectors/test-connector?workspace_id=local", "Bearer test-owner-credential")])
        saved = self.state.read()
        self.assertFalse(saved["observing"])
        self.assertFalse(saved["revocation_pending"])
        self.assertTrue(saved["disconnected"])
        self.assertNotIn("credential", saved)


if __name__ == "__main__":
    unittest.main()
