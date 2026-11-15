"""A delayed daemon acquires its queue from current, locked connection state."""

import fcntl
import json
import os
import select
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

from agentrun_cli import daemon
from agentrun_cli.queue import Queue, destination
from agentrun_cli.state import State
import test_cli_process as fixtures
import test_consent_lifecycle as consent


class DaemonStartEpochTests(unittest.TestCase):
    setUp = fixtures.CliProcessTests.setUp
    fake_executable = fixtures.CliProcessTests.fake_executable
    cli = fixtures.CliProcessTests.cli
    peer = fixtures.CliProcessTests.peer
    credential = fixtures.CliProcessTests.credential
    enroll = fixtures.CliProcessTests.enroll
    connect = consent.ConsentLifecycleTests.connect
    queued = consent.ConsentLifecycleTests.queued
    queue_checkpoint = fixtures.CliProcessTests.queue_checkpoint

    def delayed_start(self):
        entered, announce = os.pipe()
        gate, release = os.pipe()
        # Pause the real installed CLI after State construction but before lock acquisition.
        code = """import os,sys
from agentrun_cli import cli,daemon
original = daemon.lock
def delayed(directory):
    os.write(int(sys.argv[2]), b'1')
    os.close(int(sys.argv[2]))
    if os.read(int(sys.argv[3]), 1) != b'1':
        raise RuntimeError('fixture gate closed')
    os.close(int(sys.argv[3]))
    return original(directory)
daemon.lock = delayed
raise SystemExit(cli.main(['daemon','start','--foreground','--once','--state-dir',sys.argv[1]]))
"""
        child = subprocess.Popen([sys.executable, "-I", "-c", code, str(self.state_dir), str(announce), str(gate)],
                                 pass_fds=(announce, gate), env=self.env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        os.close(announce)
        os.close(gate)

        def cleanup():
            os.close(release)
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)

        self.addCleanup(cleanup)
        try:
            self.assertTrue(select.select([entered], [], [], 10)[0], "installed CLI reached the pre-lock boundary")
            self.assertEqual(os.read(entered, 1), b"1")
        finally:
            os.close(entered)
        return child, release

    def resume_start(self, child, release):
        os.write(release, b"1")
        return child.communicate(timeout=15)

    def test_delayed_start_preserves_new_destination_pending_events_and_checkpoint(self):
        old_peer, new_peer = self.peer(), self.peer()
        self.enroll(old_peer, "--refresh-seconds", "0")
        child, release = self.delayed_start()
        disconnected = self.cli("disconnect", "--credential-file", self.credential(old_peer.origin))
        self.assertEqual(disconnected.returncode, 0, disconnected.stdout + disconnected.stderr)
        sources = json.loads(self.cli("discover").stdout)["sessions"]
        self.connect(new_peer, sources[1:], queue_limit="17", queue_byte_limit="4096", refresh_seconds="120")
        new_peer.reject_delivery = True
        pending = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(pending.returncode, 0, pending.stdout + pending.stderr)
        before = self.queue_checkpoint()
        self.assertEqual(len(self.queued()), 1)
        latest = State(self.state_dir)
        old_requests = len(old_peer.requests)
        out, err = self.resume_start(child, release)
        self.assertEqual(child.returncode, 0, out + err)
        self.assertEqual(self.queue_checkpoint(), before, "startup cannot purge or reallocate a newer destination's pending event")
        with sqlite3.connect(self.state_dir / "queue.sqlite3") as db:
            self.assertEqual(db.execute("SELECT value FROM settings WHERE name='destination'").fetchone()[0], destination(latest))
        self.assertEqual(len(old_peer.requests), old_requests, "the delayed process uses only the latest receiver")

    def test_delayed_start_after_disconnect_refuses_before_opening_or_rebinding_queue(self):
        peer = self.peer()
        self.enroll(peer)
        child, release = self.delayed_start()
        disconnected = self.cli("disconnect", "--credential-file", self.credential(peer.origin))
        self.assertEqual(disconnected.returncode, 0, disconnected.stdout + disconnected.stderr)
        # A queue must not even be opened after current admission fails.
        (self.state_dir / "queue.sqlite3").unlink()
        before = State(self.state_dir).data
        requests = len(peer.requests)
        out, err = self.resume_start(child, release)
        self.assertEqual(child.returncode, 1, out + err)
        self.assertIn("not_connected", out + err)
        self.assertFalse((self.state_dir / "queue.sqlite3").exists())
        self.assertEqual(State(self.state_dir).data, before)
        self.assertEqual(len(peer.requests), requests)
        self.assertFalse(daemon.running(self.state_dir))

    def test_stale_unconnected_state_starts_the_newly_enrolled_connection(self):
        stale = State(self.state_dir)
        self.assertNotIn("connector_id", stale.data)
        peer = self.peer()
        self.enroll(peer)
        with patch.dict(os.environ, self.env, clear=True):
            result = daemon.run(stale, once=True)
        self.assertEqual(result, {"status": "delivered", "queued_events": 0})
        self.assertEqual(len(peer.accepted), 1)
        self.assertEqual(stale.data["origin"], peer.origin)
        self.assertFalse(daemon.running(self.state_dir))

    def test_queue_binding_and_latest_limits_are_loaded_under_the_config_lock(self):
        peer = self.peer()
        self.enroll(peer, "--refresh-seconds", "0")
        stale = State(self.state_dir)
        writer = State(self.state_dir)
        writer.data.update(queue_limit=17, queue_byte_limit=4096, refresh_seconds=120)
        writer.save()
        opened = []

        def opening(*args, **kwargs):
            fd = os.open(self.state_dir / "config.lock", os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError, msg="enrollment must not interleave between reload and queue binding"):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(fd)
            opened.append(kwargs)
            return Queue(*args, **kwargs)

        with patch.object(daemon, "Queue", opening), patch.object(daemon, "tick", return_value="delivered"):
            self.assertEqual(daemon.run(stale, once=True)["status"], "delivered")
        self.assertEqual(opened, [{"max_events": 17, "max_bytes": 4096, "refresh_seconds": 120, "binding": destination(writer)}])

    def startup_failure(self, failure):
        peer = self.peer()
        self.enroll(peer)
        state = State(self.state_dir)
        acquired = []
        original = daemon.lock
        read_fd, ready_fd = os.pipe()

        def acquiring(directory):
            fd = original(directory)
            acquired.append(fd)
            return fd

        try:
            with patch.object(daemon, "lock", acquiring):
                failure(state, ready_fd)
            self.assertEqual(len(acquired), 1)
            with self.assertRaises(OSError, msg="every post-lock startup failure releases its daemon fd"):
                os.fstat(acquired[0])
            self.assertFalse(daemon.running(self.state_dir))
        finally:
            # Clean up the old implementation's leaked fd only after recording the failure.
            for fd in acquired:
                try:
                    os.fstat(fd)
                except OSError:
                    continue
                os.close(fd)
            os.close(ready_fd)
            self.assertEqual(os.read(read_fd, 1), b"", "failed startup never reports ready")
            os.close(read_fd)

    def test_queue_constructor_failure_releases_daemon_lock_without_ready_signal(self):
        def failure(state, ready_fd):
            with patch.object(daemon, "Queue", side_effect=OSError("fixture queue open refused")):
                with self.assertRaisesRegex(OSError, "fixture queue open refused"):
                    daemon.run(state, ready_fd=ready_fd)
        self.startup_failure(failure)

    def test_current_state_validation_failure_does_not_open_queue_or_report_ready(self):
        def failure(state, ready_fd):
            with patch.object(state, "read", side_effect=ValueError("unsafe_state")), patch.object(daemon, "Queue") as queue:
                with self.assertRaisesRegex(ValueError, "unsafe_state"):
                    daemon.run(state, once=True, ready_fd=ready_fd)
                queue.assert_not_called()
        self.startup_failure(failure)
