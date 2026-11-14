"""Exercise the installed command boundary with local harness and HTTP peers."""

import json
import os
import pty
import queue
import select
import shlex
import signal
import sqlite3
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

import pyte
from websockets.sync.server import unix_serve

ROOT = Path(__file__).resolve().parents[1]


class TerminalProcess:
    """Drive the public command using a real terminal and synthetic peers."""

    def __init__(self, command, env):
        self.master, self.slave = pty.openpty()
        termios.tcsetwinsize(self.slave, (30, 100))
        self.original_mode = termios.tcgetattr(self.slave)
        self.output = ""
        self.screen = pyte.Screen(100, 30)
        self.stream = pyte.Stream(self.screen)
        self.process = subprocess.Popen(command, stdin=self.slave, stdout=self.slave, stderr=self.slave,
                                        env={**env, "TERM": env.get("TERM", "xterm-256color"),
                                             "PROMPT_TOOLKIT_NO_CPR": "1"})

    def send(self, keys):
        os.write(self.master, keys.encode())

    def expect(self, text):
        deadline = time.monotonic() + 10
        while text not in "\n".join(self.screen.display):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.master], [], [], remaining)[0]:
                raise AssertionError(f"Terminal never displayed {text!r}: {self.output[-3000:]!r}")
            chunk = os.read(self.master, 65536).decode(errors="replace")
            self.output += chunk
            self.stream.feed(chunk)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=5)
        os.close(self.master)
        os.close(self.slave)


class Peer:
    def __init__(self):
        self.requests = []
        self.request_headers = []
        self.connector = None
        self.lose_ack = False
        self.event_response_delay = 0
        self.accepted = {}
        self.selection_override = None
        self.reject_delivery = False
        self.revoked = False
        self.delete_fails = False
        self.active_credential = "narrow-connector-test"
        self.redirect_to = None
        self.rate_limit = False
        self.lose_registration = False
        self.registration_body = None
        self.malformed_response = None
        self.truncated_response = None
        self.identity_status = 200
        self.retry_after = "120"
        self.telemetry_available = True
        self.telemetry_capabilities = {
            "version": 1, "ingestion_modes": ["polling", "otlp"],
            "supported_harnesses": ["claude", "codex"], "logs_formats": ["json", "protobuf"],
            "logs_endpoint_template": "/api/v2/control/connectors/{connector_id}/otel/v1/logs",
            "selections_revision_header": "X-AgentRun-Selections-Revision",
            "max_log_records": 100, "max_payload_bytes": 65536,
            "privacy": {"metadata_only": True, "session_id_attribute": "agentrun.session_id",
                        "session_id_format": "sha256", "raw_session_ids": False},
            "token_usage": {"supported_harnesses": ["claude", "codex"], "model_attribute": "agentrun.model",
                            "count_attributes": ["agentrun.input_tokens", "agentrun.output_tokens",
                                                 "agentrun.cache_read_tokens", "agentrun.cache_write_tokens"],
                            "input_includes_cache": True},
        }
        peer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def do_DELETE(self):
                self.handle_request()

            def do_PATCH(self):
                self.handle_request()

            def handle_request(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = ({key: values[0] for key, values in parse_qs(raw.decode()).items()}
                        if raw and self.headers.get("Content-Type") == "application/x-www-form-urlencoded" else
                        json.loads(raw) if raw else None)
                peer.requests.append((self.command, self.path, self.headers.get("Authorization"), body))
                peer.request_headers.append(dict(self.headers))
                code, payload = peer.respond(self.command, self.path, body)
                if code == 0:
                    self.close_connection = True
                    return
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                truncated = peer.truncated_response and self.path.endswith(peer.truncated_response[0])
                if truncated:
                    self.protocol_version = "HTTP/1.1"
                    self.close_connection = True
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                if truncated:
                    self.send_header("Transfer-Encoding", "chunked")
                    self.send_header("Connection", "close")
                else:
                    self.send_header("Content-Length", str(len(data)))
                if code == 302:
                    self.send_header("Location", peer.redirect_to)
                if code == 429 or truncated:
                    self.send_header("Retry-After", peer.retry_after)
                self.end_headers()
                if truncated:
                    # Valid JSON alone is insufficient: the final zero chunk never arrives.
                    self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                    self.wfile.flush()
                else:
                    self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def respond(self, method, path, body):
        if self.truncated_response and path.endswith(self.truncated_response[0]) and self.truncated_response[1] != 200:
            return self.truncated_response[1], {"detail": {"code": "test_refusal"}}
        if path.endswith("/connectors/capabilities"):
            return (200, self.telemetry_capabilities) if self.telemetry_available else (404, {})
        if self.malformed_response and path.endswith(self.malformed_response[0]):
            return 200, self.malformed_response[1]
        if path.endswith("/identity"):
            if self.identity_status != 200:
                return self.identity_status, {"detail": {"message": "SECRET remote error"}}
            if self.redirect_to:
                return 302, {"SECRET": "do not print upstream payload"}
            return 200, {"user_id": "test", "workspace_ids": ["personal:test"]}
        if path.endswith("/connectors") and method == "POST":
            if self.connector is not None:
                if self.registration_body["operation_id"] == body["operation_id"] and self.registration_body != body:
                    return 409, {"detail": {"code": "idempotency_conflict"}}
                return 409, {"detail": {"code": "connector_reauthentication_required", "connector_id": self.connector["id"]}}
            self.registration_body = body
            self.connector = {"id": "connector-test", "workspace_id": body["workspace_id"], "ingestion_mode": body["ingestion_mode"],
                              "selections_revision": 1, "selections": body["selections"]}
            if self.lose_registration:
                self.lose_registration = False
                return 503, {"detail": {"code": "temporarily_unavailable"}}
            return 201, {"connector": self.connector, "credential": "narrow-connector-test",
                         "credential_expires_at": "2099-01-01T00:00:00Z"}
        if "/rotate-credential" in path:
            self.active_credential = "narrow-rotated-test"
            self.revoked = False
            return 200, {"connector": self.connector, "credential": self.active_credential,
                         "credential_expires_at": "2099-01-01T00:00:00Z"}
        if "/selections" in path and method == "PATCH":
            self.connector.update(selections=body["selections"], selections_revision=body["selections_revision"] + 1)
            return 200, self.connector
        if path.endswith("/heartbeat"):
            if self.revoked:
                return 401, {"detail": {"code": "connector_unauthorized"}}
            return 200, {"connector_id": "connector-test", "selections_revision": self.connector["selections_revision"] if self.selection_override is None else 2,
                         "selections": self.connector["selections"] if self.selection_override is None else self.selection_override,
                         "heartbeat_interval_seconds": 30}
        if path.endswith("/events"):
            if self.event_response_delay:
                threading.Event().wait(self.event_response_delay)
            if self.rate_limit:
                return 429, {"detail": {"code": "rate_limited"}}
            if self.reject_delivery:
                return 503, {"detail": {"code": "temporarily_unavailable"}}
            for event in body["events"]:
                self.accepted[event["event_id"]] = event
            if self.lose_ack:
                self.lose_ack = False
                return 503, {"detail": {"code": "temporarily_unavailable"}}
            return 200, {"accepted_event_ids": [event["event_id"] for event in body["events"]]}
        if method == "DELETE":
            if self.delete_fails:
                return 503, {"detail": {"code": "temporarily_unavailable"}}
            self.revoked = True
            return 200, {**self.connector, "state": "revoked"}
        return 404, {"detail": {"code": "not_found"}}

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class DevicePeer(Peer):
    def __init__(self):
        self.device_metadata = None
        self.device_response = None
        self.token_responses = []
        self.token_gate = None
        self.auth_responses = {}
        super().__init__()
        self.retry_after = "1"

    def respond(self, method, path, body):
        if path in self.auth_responses:
            return self.auth_responses[path]
        if path.endswith("/auth/device"):
            return 200, self.device_metadata if self.device_metadata is not None else {
                "issuer": self.origin + "/project", "client_id": "device-test-client",
                "device_authorization_endpoint": self.origin + "/oauth/device",
                "token_endpoint": self.origin + "/oauth/token", "scope": "research:read research:write", "resource": "agentrun",
            }
        if path == "/oauth/device":
            return 200, self.device_response if self.device_response is not None else {
                "device_code": "SECRET-device-code", "user_code": "ABCD-EFGH",
                "verification_uri": self.origin + "/verify", "expires_in": 600, "interval": 1,
            }
        if path == "/oauth/token":
            if self.token_gate is not None:
                self.token_gate.wait(timeout=15)
            if self.token_responses:
                return self.token_responses.pop(0)
            return 200, {"access_token": "-".join(["SECRET", "access", "token"]), "token_type": "Bearer", "expires_in": 600,
                         "refresh_token": "-".join(["SECRET", "refresh", "token"]), "id_token": "-".join(["SECRET", "id", "token"])}
        return super().respond(method, path, body)


class CliProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.state_dir = self.home / "state"
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.sessions = self.home / "sessions.json"
        self.sessions.write_text(json.dumps([
            {"sessionId": "11111111-1111-4111-8111-111111111111", "cwd": "/private/client-a",
             "kind": "interactive", "startedAt": 1000, "status": "busy", "name": "SECRET prompt"},
            {"sessionId": "22222222-2222-4222-8222-222222222222", "cwd": "/private/client-b",
             "kind": "interactive", "startedAt": 2000, "status": "idle", "name": "OTHER SECRET"},
        ]))
        self.fake_executable("claude", "import os,pathlib\nprint(pathlib.Path(os.environ['HARNESS_ROWS']).read_text())")
        self.fake_executable("codex", "raise SystemExit(1)")
        self.env = {**os.environ, "HOME": str(self.home), "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "HARNESS_ROWS": str(self.sessions), "PYTHONPATH": str(ROOT / "src")}

    def fake_executable(self, name, code):
        file = self.bin / name
        file.write_text(f"#!{sys.executable}\n{code}\n")
        file.chmod(0o700)

    def cli(self, *args, input="", timeout=15):
        return subprocess.run([sys.executable, "-I", "-m", "agentrun_cli", *args, "--state-dir", str(self.state_dir)],
                              input=input, capture_output=True, text=True, env=self.env, timeout=timeout)

    def hostile_pythonpath(self):
        directory = self.home / "untrusted-imports"
        directory.mkdir()
        marker = self.home / "untrusted-module-executed"
        (directory / "agentrun_cli.py").write_text(
            f"from pathlib import Path\nPath({str(marker)!r}).touch()\nraise SystemExit(97)\n"
        )
        self.env["PYTHONPATH"] = str(directory)
        return marker

    def peer(self):
        peer = Peer()
        self.addCleanup(peer.close)
        return peer

    def device_peer(self):
        peer = DevicePeer()
        self.addCleanup(peer.close)
        return peer

    def credential(self, origin):
        file = self.home / "credential.json"
        file.write_text(json.dumps({"origin": origin, "api_key": "-".join(["broad", "secret", "never", "retain"])}))
        file.chmod(0o600)
        return str(file)

    def enroll(self, peer, *extra):
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                          "--credential-file", self.credential(peer.origin), "--select", selected["id"], "--yes", "--no-start", *extra)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return selected

    def terminal_connect(self, peer, **environment):
        command = [sys.executable, "-m", "agentrun_cli", "connect", "--origin", peer.origin,
                   "--workspace-id", "personal:test", "--credential-file", self.credential(peer.origin),
                   "--no-start", "--state-dir", str(self.state_dir)]
        terminal = TerminalProcess(command, {**self.env, "TERM": "xterm-256color", **environment})
        self.addCleanup(terminal.close)
        terminal.expect("Use this destination workspace?")
        terminal.send("y\n")
        return terminal

    def test_deployment_connect_without_local_sessions_keeps_enrollment_secret_out_of_collector_bundle(self):
        # Deployments enroll before sessions exist; the exported secret must grant ingestion only.
        peer = self.peer()
        self.sessions.write_text("[]")
        self.env["DEPLOYMENT_KEY"] = "broad-secret-never-retain"
        result = self.cli("connect", "--telemetry", "--origin", peer.origin,
                          "--workspace-id", "personal:test", "--credential-env", "DEPLOYMENT_KEY",
                          "--subscribe-harness", "claude", "--subscribe-harness", "codex", "--yes")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "configured")
        self.assertEqual(output["daemon"], "stopped")
        self.assertEqual(output["telemetry"]["token_usage_harnesses"], ["claude", "codex"])
        self.assertEqual(peer.registration_body["ingestion_mode"], "otlp")
        self.assertEqual({s["harness"] for s in peer.connector["selections"]}, {"claude", "codex"})
        self.assertTrue(all(s["mode"] == "harness" and s["include_future_sessions"] for s in peer.connector["selections"]))
        bundle = Path(output["telemetry"]["directory"])
        exported = "\n".join(file.read_text() for file in bundle.iterdir() if file.is_file())
        self.assertNotIn("broad-secret-never-retain", exported + result.stdout + result.stderr)
        self.assertNotIn("narrow-connector-test", result.stdout + result.stderr)
        self.assertIn("narrow-connector-test", (bundle / "collector.env").read_text())
        self.assertEqual((bundle / "collector.env").stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.home / ".codex" / "config.toml").exists())
        local_status = json.loads(self.cli("status").stdout)
        self.assertEqual(local_status["ingestion_mode"], "otlp")
        self.assertFalse(local_status["observing"])
        self.assertEqual(local_status["delivery_state"], "unverified")
        self.assertNotEqual(self.cli("daemon", "start", "--once").returncode, 0)
        disconnected = self.cli("disconnect", "--origin", peer.origin, "--credential-env", "DEPLOYMENT_KEY")
        self.assertEqual(disconnected.returncode, 0, disconnected.stdout + disconnected.stderr)
        self.assertTrue(peer.revoked)
        self.assertFalse((bundle / "collector.env").exists())

    def test_claude_hook_forwards_only_known_lifecycle_metadata_to_loopback_and_never_blocks_agent(self):
        # Hooks receive prompts/tool payloads; the bridge must not send them to telemetry or fail the agent.
        peer = self.peer()
        self.env["DEPLOYMENT_KEY"] = "broad-secret-never-retain"
        runtime = self.home / "runtime with 'quotes'"
        runtime.symlink_to(Path(sys.executable).parent.parent, target_is_directory=True)
        connected = subprocess.run([
            str(runtime / "bin" / Path(sys.executable).name), "-I", "-m", "agentrun_cli",
            "connect", "--telemetry", "--origin", peer.origin, "--workspace-id", "personal:test",
            "--credential-env", "DEPLOYMENT_KEY", "--subscribe-harness", "claude", "--yes",
            "--state-dir", str(self.state_dir),
        ], capture_output=True, text=True, env=self.env, timeout=15)
        self.assertEqual(connected.returncode, 0, connected.stdout + connected.stderr)
        bundle = Path(json.loads(connected.stdout)["telemetry"]["directory"])
        hooks = json.loads((bundle / "claude-hooks.json").read_text())["hooks"]
        marker = self.hostile_pythonpath()
        self.env["PATH"] = str(self.bin)
        self.env.update({"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1",
                         "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": "", "no_proxy": ""})

        def run_hook(event, endpoint, payload):
            generated = hooks[event if event in hooks else "UserPromptSubmit"][0]["hooks"][0]["command"]
            return subprocess.run(["/bin/sh", "-c", generated + " --hook-endpoint " + shlex.quote(endpoint)],
                                  input=payload, capture_output=True, text=True, env=self.env, timeout=15)

        for hook_event, notification, activity in [
            ("UserPromptSubmit", None, "working"), ("Stop", None, "idle"),
            ("Notification", "permission_prompt", "waiting_input"), ("SessionEnd", None, "stopped"),
            ("Notification", "idle_prompt", None), ("Unknown", None, None),
        ]:
            with self.subTest(hook_event=hook_event, notification=notification):
                before = len(peer.requests)
                payload = {"hook_event_name": hook_event, "session_id": "native-session", "prompt": "SECRET prompt",
                           "transcript_path": "/SECRET/path", "notification_type": notification}
                result = run_hook(hook_event, peer.origin + "/v1/logs", json.dumps(payload))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
                if activity:
                    self.assertEqual(len(peer.requests), before + 1)
                    request = peer.requests[-1]
                    self.assertIsNone(request[2])
                    record = request[3]["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]
                    attrs = {item["key"]: item["value"]["stringValue"] for item in record["attributes"]}
                    self.assertEqual(attrs, {"event.name": "agentrun.session." + activity, "session.id": "native-session"})
                    self.assertNotIn("SECRET", json.dumps(request))
                else:
                    self.assertEqual(len(peer.requests), before)
        for endpoint, payload in [("https://example.com/v1/logs", "{}"), (peer.origin + "/v1/logs", "bad-json"),
                                  ("http://127.0.0.1:1/v1/logs", json.dumps({"hook_event_name": "Stop", "session_id": "x"}))]:
            result = run_hook("UserPromptSubmit", endpoint, payload)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout + result.stderr, "")
        self.assertFalse(marker.exists())

    def test_telemetry_refuses_unsupported_destination_and_implicit_scope_before_authentication(self):
        # An old API or missing future-session consent must never enroll a deployment.
        peer = self.peer()
        self.env["DEPLOYMENT_KEY"] = "broad-secret-never-retain"
        base = ("connect", "--telemetry", "--origin", peer.origin, "--workspace-id", "personal:test",
                "--credential-env", "DEPLOYMENT_KEY", "--yes")
        cases = [([], True, "telemetry_scope_required"),
                 (["--subscribe-harness", "claude", "--select", "existing"], True, "telemetry_scope_required"),
                 (["--subscribe-harness", "claude"], False, "telemetry_unavailable")]
        for flags, available, expected in cases:
            with self.subTest(expected=expected, flags=flags):
                peer.telemetry_available = available
                result = self.cli(*base, *flags)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout)["error"], expected)
                self.assertNotIn("broad-secret-never-retain", result.stdout + result.stderr)
        self.assertTrue(all(row[1].endswith("/capabilities") and row[2] is None for row in peer.requests))

    def test_telemetry_requires_advertised_harnesses_and_valid_capabilities_before_credentials(self):
        # Even a valid OTLP transport cannot enroll a harness the destination does not support.
        peer = self.peer()
        defaults = peer.telemetry_capabilities
        self.env.pop("UNAVAILABLE_DEPLOYMENT_KEY", None)
        base = ("connect", "--telemetry", "--origin", peer.origin, "--workspace-id", "personal:test",
                "--credential-env", "UNAVAILABLE_DEPLOYMENT_KEY", "--subscribe-harness", "claude", "--yes")
        cases = [
            ("unsupported_harness", {**defaults, "supported_harnesses": ["codex"]}),
            ("empty_harnesses", {**defaults, "supported_harnesses": []}),
            ("harnesses_not_list", {**defaults, "supported_harnesses": "claude"}),
            ("harness_not_string", {**defaults, "supported_harnesses": [True]}),
            ("privacy_not_object", {**defaults, "privacy": []}),
            ("metadata_flag_not_boolean", {**defaults, "privacy": {**defaults["privacy"], "metadata_only": 1}}),
            ("raw_identity_flag_not_boolean", {**defaults, "privacy": {**defaults["privacy"], "raw_session_ids": 0}}),
            ("record_limit_not_integer", {**defaults, "max_log_records": "100"}),
            ("formats_not_list", {**defaults, "logs_formats": None}),
            ("token_usage_not_object", {**defaults, "token_usage": []}),
            ("token_usage_cache_not_boolean", {**defaults, "token_usage": {**defaults["token_usage"], "input_includes_cache": 1}}),
            ("token_usage_unreviewed_field", {**defaults, "token_usage": {**defaults["token_usage"], "model_attribute": "prompt"}}),
        ]
        cases.extend(("missing_" + field, {key: value for key, value in defaults.items() if key != field})
                     for field in defaults if field != "token_usage")
        for label, capabilities in cases:
            with self.subTest(case=label):
                peer.telemetry_capabilities = capabilities
                result = self.cli(*base)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout)["error"], "telemetry_unavailable")
                self.assertEqual(result.stderr, "")
        self.assertEqual(len(peer.requests), len(cases))
        self.assertTrue(all(row[1].endswith("/capabilities") and row[2] is None for row in peer.requests))
        self.assertIsNone(peer.connector)
        self.assertFalse((self.state_dir / "telemetry").exists())

    def test_telemetry_accepts_the_selected_harness_when_other_harnesses_are_unavailable(self):
        peer = self.peer()
        peer.telemetry_capabilities["supported_harnesses"] = ["codex"]
        peer.telemetry_capabilities.pop("token_usage")
        self.env["DEPLOYMENT_KEY"] = "broad-secret-never-retain"
        result = self.cli("connect", "--telemetry", "--origin", peer.origin,
                          "--workspace-id", "personal:test", "--credential-env", "DEPLOYMENT_KEY",
                          "--subscribe-harness", "codex", "--yes")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "configured")
        self.assertEqual(json.loads(result.stdout)["telemetry"]["token_usage_harnesses"], [])
        self.assertEqual([source["harness"] for source in peer.registration_body["selections"]], ["codex"])

    def test_setup_reports_existing_destinations_without_secret_values_or_configuration_changes(self):
        # Detecting deployment intent must not redirect telemetry already configured by the operator.
        codex = self.home / ".codex"
        codex.mkdir()
        self.env["CODEX_HOME"] = str(codex)
        config = codex / "config.toml"
        original = '[otel]\nexporter = "none"\n# SECRET existing destination\n'
        config.write_text(original)
        self.env["OTEL_EXPORTER_OTLP_HEADERS"] = "Authorization=SECRET-existing"
        self.env["KUBERNETES_SERVICE_HOST"] = "10.0.0.1"
        self.fake_executable("codex", 'print("codex-cli 0.160.1")')
        for target, expected in [("deployment", "native_otlp"), ("existing-sessions", "observer")]:
            result = self.cli("setup", "--target", target)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["environment"], "kubernetes")
            self.assertEqual(report["recommendation"], expected)
            self.assertTrue(report["existing_telemetry"]["codex_config_present"])
            self.assertIn("OTEL_EXPORTER_OTLP_HEADERS", report["existing_telemetry"]["environment_variable_names"])
            self.assertNotIn("SECRET", result.stdout + result.stderr)
            self.assertFalse(report["configuration_changed"])
            self.assertEqual(config.read_text(), original)
            self.assertFalse(self.state_dir.exists())

    def codex_listing(self):
        def handle(socket):
            for message in socket:
                value = json.loads(message)
                if "id" not in value:
                    continue
                result = {"userAgent": "codex/test"}
                if value["method"] == "thread/list":
                    result = {"data": [{"id": "native-codex-thread", "cwd": "/private/codex-project",
                                        "status": {"type": "notLoaded"}, "name": "SECRET title"}], "nextCursor": None}
                socket.send(json.dumps({"id": value["id"], "result": result}))

        socket_path = str(self.home / "picker-codex.sock")
        server = unix_serve(handle, socket_path)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.fake_executable("codex", "print(" + repr(json.dumps({"status": "running", "socketPath": socket_path,
                                                                 "appServerVersion": "0.160.1"})) + ")")

    def test_tty_picker_connects_only_checked_sessions_after_review_and_restores_terminal(self):
        # The pipe walkthrough cannot catch raw-terminal navigation or accidental group consent.
        peer = self.peer()
        terminal = self.terminal_connect(peer)
        terminal.expect("Choose harness")
        terminal.send("\r")
        terminal.expect("Projects")
        terminal.send("\r")
        terminal.expect("Select sessions")
        terminal.send(" \t")
        terminal.expect("Review connection")
        terminal.expect("1 existing session")
        self.assertFalse(any(request[0] == "POST" for request in peer.requests))
        terminal.send("\r")
        terminal.expect("Confirm workspace and metadata selection?")
        terminal.send("y\n")
        terminal.expect("Start automatically after login")
        terminal.send("n\n")
        terminal.expect('"status": "connected"')
        self.assertEqual(terminal.process.wait(timeout=5), 0, terminal.output)
        self.assertEqual(termios.tcgetattr(terminal.slave), terminal.original_mode)
        selections = peer.connector["selections"]
        self.assertEqual(len(selections), 1)
        self.assertEqual(selections[0]["mode"], "session")
        self.assertFalse(selections[0]["include_future_sessions"])
        wire = json.dumps(peer.requests)
        for forbidden in ["SECRET", "/private", "11111111-1111-4111-8111-111111111111"]:
            self.assertNotIn(forbidden, wire)

    def test_tty_picker_retains_sessions_across_filtered_projects_and_harnesses(self):
        # Real keyboard filtering/back navigation must not drop consent selected in another group.
        self.codex_listing()
        peer = self.peer()
        terminal = self.terminal_connect(peer)
        terminal.expect("Choose harness")
        terminal.send("\r")
        terminal.expect("Projects")
        terminal.send("/client-b\r")
        terminal.expect("Filter: client-b")
        terminal.send("\r")
        terminal.expect("Select sessions")
        terminal.send(" \x1b[D")
        terminal.expect("Projects")
        terminal.send("\x1b[D")
        terminal.expect("Choose harness")
        terminal.send("\x1b[B\r")
        terminal.expect("Projects")
        terminal.send("\r")
        terminal.expect("Select sessions")
        terminal.send(" \t")
        terminal.expect("Review connection")
        terminal.expect("2 existing session")
        terminal.send("\r")
        terminal.expect("Confirm workspace and metadata selection?")
        terminal.send("y\n")
        terminal.expect("Start automatically after login")
        terminal.send("n\n")
        terminal.expect('"status": "connected"')
        self.assertEqual(terminal.process.wait(timeout=5), 0)
        selected = peer.connector["selections"]
        self.assertEqual({item["harness"] for item in selected}, {"claude", "codex"})
        local = json.loads(self.cli("discover").stdout)["sessions"]
        expected = {item["id"] for item in local if item["project_label"] in {"client-b", "codex-project"}}
        self.assertEqual({item["external_session_id"] for item in selected}, expected)
        self.assertTrue(all(item["mode"] == "session" and not item["include_future_sessions"] for item in selected))
        self.assertNotIn("SECRET", terminal.output + json.dumps(peer.requests))

    def test_tty_select_all_and_clear_respect_filtered_scope_without_future_consent(self):
        # Bulk selection must remain existing-session consent, retain hidden selections, and exceed the old 64 cap safely.
        self.sessions.write_text(json.dumps([
            {"sessionId": f"{index:08x}-1111-4111-8111-111111111111", "cwd": "/private/client-a" if index < 70 else "/private/client-b",
             "kind": "interactive", "startedAt": 1000, "status": "idle"} for index in range(75)
        ]))
        peer = self.peer()
        terminal = self.terminal_connect(peer)
        terminal.expect("Choose harness")
        terminal.send("\r")
        terminal.expect("Select all existing sessions (75)")
        terminal.send("a")
        terminal.expect("75 existing session")
        terminal.send("/client-b\r")
        terminal.expect("Select all filtered existing sessions (5)")
        terminal.send("x")
        terminal.expect("70 existing session")
        terminal.send("\t")
        terminal.expect("Review connection")
        terminal.send("\r")
        terminal.expect("Confirm workspace and metadata selection?")
        terminal.send("y\n")
        terminal.expect("Start automatically after login")
        terminal.send("n\n")
        terminal.expect('"status": "connected"')
        self.assertEqual(terminal.process.wait(timeout=5), 0, terminal.output)
        selections = peer.connector["selections"]
        self.assertEqual(len(selections), 70)
        self.assertTrue(all(item["mode"] == "session" and not item["include_future_sessions"] for item in selections))
        local = json.loads(self.cli("discover").stdout)["sessions"]
        self.assertEqual({item["source_id"] for item in selections},
                         {item["id"] for item in local if item["project_label"] == "client-a"})
        delivered = self.cli("daemon", "start", "--once")
        self.assertEqual(delivered.returncode, 0, delivered.stdout + delivered.stderr)
        self.assertTrue(any(request[1].endswith("/heartbeat") for request in peer.requests))
        self.assertEqual(json.loads(self.cli("status").stdout)["delivery_state"], "delivered")
        self.assertEqual(json.loads(delivered.stdout)["queued_events"], 0)
        self.assertEqual(len(peer.accepted), 70)

    def test_tty_future_subscriptions_require_separate_explicit_project_and_harness_choices(self):
        # Existing-session Select all/Clear must neither create nor erase independent future consent.
        peer = self.peer()
        terminal = self.terminal_connect(peer)
        terminal.expect("Choose harness")
        terminal.send("\r")
        terminal.expect("Projects")
        terminal.send("\r")
        terminal.expect("Select sessions")
        terminal.expect("Include future sessions in this project")
        terminal.send("\x1b[F ")
        terminal.expect("1 future subscription")
        terminal.send("\x1b[D")
        terminal.expect("Projects")
        terminal.expect("Include future sessions across this harness")
        terminal.send("\x1b[F ax\t")
        terminal.expect("Review connection")
        terminal.expect("0 existing session")
        terminal.expect("2 future subscription")
        terminal.send("\r")
        terminal.expect("Confirm workspace and metadata selection?")
        terminal.send("y\n")
        terminal.expect("Start automatically after login")
        terminal.send("n\n")
        terminal.expect('"status": "connected"')
        self.assertEqual(terminal.process.wait(timeout=5), 0, terminal.output)
        selections = peer.connector["selections"]
        self.assertEqual({item["mode"] for item in selections}, {"project", "harness"})
        self.assertTrue(all(item["include_future_sessions"] and item["external_session_id"] is None for item in selections))

    def test_large_explicit_harness_subscription_bounds_each_drain_and_reports_remaining_backlog(self):
        # A future subscription can discover more than one pass can drain; it must yield with honest queue status.
        self.sessions.write_text(json.dumps([
            {"sessionId": f"{index:08x}-1111-4111-8111-111111111111", "cwd": "/private/client-a",
             "kind": "interactive", "startedAt": 1000, "status": "idle"} for index in range(1100)
        ]))
        peer = self.peer()
        self.enroll(peer, "--subscribe-harness", "claude", "--queue-limit", "2000")
        result = self.cli("daemon", "start", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout), {"status": "queued", "queued_events": 100})
        self.assertEqual(len(peer.accepted), 1000)
        deliveries = [request[3] for request in peer.requests if request[1].endswith("/events")]
        self.assertEqual(len(deliveries), 20)
        self.assertTrue(all(len(body["events"]) <= 50 for body in deliveries))
        current = json.loads(self.cli("status").stdout)
        self.assertEqual(current["delivery_state"], "queued")
        self.assertEqual(current["dropped_events"], 0)

    def test_slow_successful_acknowledgements_yield_with_backlog_before_another_batch(self):
        # Real provider latency is the process boundary: a bounded request count alone can block stop for minutes.
        self.sessions.write_text(json.dumps([
            {"sessionId": f"{index:08x}-1111-4111-8111-111111111111", "cwd": "/private/client-a",
             "kind": "interactive", "startedAt": 1000, "status": "idle"} for index in range(150)
        ]))
        peer = self.peer()
        self.enroll(peer, "--subscribe-harness", "claude")
        peer.event_response_delay = 5.25
        result = self.cli("daemon", "start", "--once", timeout=45)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "queued")
        self.assertGreaterEqual(payload["queued_events"], 50)
        deliveries = [request for request in peer.requests if request[1].endswith("/events")]
        self.assertGreaterEqual(len(deliveries), 1)
        self.assertLessEqual(len(deliveries), 2)
        self.assertGreaterEqual(len(peer.accepted), 50)
        self.assertEqual(json.loads(self.cli("status").stdout)["delivery_state"], "queued")

    def test_tty_review_blocks_empty_or_over_limit_consent_and_cancellation_restores_terminal(self):
        # Invalid review must stay editable, never enroll, and cancel without leaving the terminal raw.
        peer = self.peer()
        for count, message in [(0, "Select at least one session or future subscription"),
                               (1001, "1,001 selections exceed the 1,000 limit")]:
            with self.subTest(count=count):
                self.state_dir = self.home / f"review-{count}"
                if count:
                    self.sessions.write_text(json.dumps([
                        {"sessionId": f"{index:08x}-1111-4111-8111-111111111111", "cwd": "/private/client-a",
                         "kind": "interactive", "startedAt": 1000, "status": "idle"} for index in range(count)
                    ]))
                terminal = self.terminal_connect(peer)
                terminal.expect("Choose harness")
                terminal.send(("a" if count else "") + "\t\r")
                terminal.expect("Review connection")
                terminal.expect(message)
                terminal.send("\x1b[D")
                terminal.expect("Choose harness")
                terminal.send("/unfinished search\x03")
                terminal.expect('"status": "cancelled"')
                self.assertEqual(terminal.process.wait(timeout=5), 0, terminal.output)
                self.assertEqual(termios.tcgetattr(terminal.slave), terminal.original_mode)
                self.assertFalse(any(request[0] == "POST" for request in peer.requests))
                saved = json.loads((self.state_dir / "config.json").read_text())
                self.assertNotIn("credential", saved)
                self.assertNotIn("connector_id", saved)

    def test_dumb_terminal_explicitly_falls_back_to_plain_session_selection(self):
        # Unsupported terminals must retain usable consent instead of receiving an alternate-screen UI.
        peer = self.peer()
        terminal = self.terminal_connect(peer, TERM="dumb")
        terminal.expect("Plain selection mode")
        terminal.expect("Select comma-separated sessions/subscriptions")
        terminal.send("1\n")
        terminal.expect("Confirm workspace and metadata selection?")
        terminal.send("y\n")
        terminal.expect("Start automatically after login")
        terminal.send("n\n")
        terminal.expect('"status": "connected"')
        self.assertEqual(terminal.process.wait(timeout=5), 0, terminal.output)
        self.assertEqual(len(peer.connector["selections"]), 1)
        self.assertFalse(peer.connector["selections"][0]["include_future_sessions"])
        self.assertNotIn("\x1b[?1049h", terminal.output)

    def test_cancelling_discovery_never_enrolls_or_connects_unselected_sessions(self):
        # New public CLI: catches an implicit "connect everything" default.
        discovered = self.cli("discover")
        self.assertEqual(discovered.returncode, 0, discovered.stderr)
        rows = json.loads(discovered.stdout)["sessions"]
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]["id"], rows[1]["id"])
        self.assertNotIn("SECRET", discovered.stdout)
        again = json.loads(self.cli("discover").stdout)["sessions"]
        self.assertEqual([x["id"] for x in rows], [x["id"] for x in again])
        peer = self.peer()
        for response in ["y\nnone\n", "y\n\n"]:
            cancelled = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                                 "--credential-file", self.credential(peer.origin), input=response)
            self.assertEqual(cancelled.returncode, 0, cancelled.stderr)
            self.assertIn('"status": "cancelled"', cancelled.stdout)
        self.assertFalse(any(request[0] == "POST" for request in peer.requests))

    def test_errors_explain_safe_recovery_without_printing_remote_details(self):
        peer = self.peer()
        command = ("connect", "--origin", peer.origin, "--workspace-id", "personal:test", "--select", "opaque", "--yes")
        cases = [(command, "credential_file_required"),
                 (("connect", "--origin", "http://unsafe.example"), "invalid_origin"),
                 (("daemon", "start", "--once"), "not_connected")]
        for args, code in cases:
            with self.subTest(code=code):
                result = self.cli(*args)
                self.assertEqual(result.returncode, 1)
                payload = json.loads(result.stdout)
                self.assertEqual(payload["error"], code)
                self.assertTrue(payload["message"])
        for status, code in [(401, "authentication_failed"), (403, "permission_denied"), (503, "service_unavailable")]:
            peer.identity_status = status
            result = self.cli(*command, "--credential-file", self.credential(peer.origin))
            self.assertEqual(json.loads(result.stdout)["error"], code)
            self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_explicit_enrollment_sends_only_selected_metadata_and_does_not_retain_broad_key(self):
        # No existing enrollment test: HTTP wire and persisted files expose privacy failures.
        peer = self.peer()
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                          "--credential-file", self.credential(peer.origin), "--select", selected["id"], "--yes", "--no-start")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        enrollment = [r[3] for r in peer.requests if r[0] == "POST"][0]
        self.assertEqual(enrollment["selections"], [{"source_id": selected["id"], "harness": "claude", "mode": "session",
                                                   "external_session_id": selected["id"], "include_future_sessions": False}])
        wire = json.dumps(enrollment)
        for forbidden in ["SECRET", "/private", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]:
            self.assertNotIn(forbidden, wire)
        status = self.cli("status")
        self.assertEqual(status.returncode, 0, status.stdout)
        self.assertEqual(json.loads(status.stdout)["connector_id"], "connector-test")
        for file in (self.home / "state").rglob("*"):
            if file.is_file():
                self.assertNotIn(b"broad-secret-never-retain", file.read_bytes())
        self.assertNotIn("narrow-connector-test", result.stdout + status.stdout)

    def test_device_auth_enrolls_headlessly_and_retains_only_the_connector_credential(self):
        # New auth boundary: a device grant must enroll without a pasted API key or persisted provider token.
        peer = self.device_peer()
        token = peer.respond("POST", "/oauth/token", {})[1]
        peer.device_metadata = {**peer.respond("GET", "/api/v2/control/auth/device", None)[1],
                                "verification_uri": "https://console.example.test/device"}
        token.pop("expires_in")
        peer.token_responses = [(200, token)]
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                          "--device-auth", "--select", selected["id"], "--yes", "--no-start")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(lines[0]["verification_uri"], "https://console.example.test/device")
        self.assertEqual(lines[0]["user_code"], "ABCD-EFGH")
        self.assertEqual(lines[-1]["status"], "connected")
        self.assertEqual(peer.requests[0][1:], ("/api/v2/control/auth/device", None, None))
        self.assertEqual(peer.requests[1][2:], (None, {"client_id": "device-test-client", "scope": "research:read research:write", "audience": "agentrun"}))
        self.assertTrue(peer.request_headers[0]["User-Agent"].startswith("agentrun-cli/"))
        self.assertEqual(peer.requests[2][2:], (None, {"grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                                                     "device_code": "SECRET-device-code", "client_id": "device-test-client", "audience": "agentrun"}))
        self.assertTrue(all(row[2] == "Bearer SECRET-access-token" for row in peer.requests[3:]))
        for value in ["SECRET-device-code", "SECRET-access-token", "SECRET-refresh-token", "SECRET-id-token"]:
            self.assertNotIn(value, result.stdout + result.stderr)
            for file in self.state_dir.rglob("*"):
                if file.is_file():
                    self.assertNotIn(value.encode(), file.read_bytes())
        self.assertEqual(json.loads((self.state_dir / "config.json").read_text())["credential"], "narrow-connector-test")

    def test_device_auth_flushes_code_then_waits_through_pending_and_slow_down(self):
        # Same process/HTTP boundary; the provider gate catches instructions buffered until login has finished.
        peer = self.device_peer()
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        peer.token_gate = threading.Event()
        peer.token_responses = [(400, {"error": "authorization_pending"}), (200, {"error": "slow_down"}),
                                (200, {"error": "authorization_pending"})]
        process = subprocess.Popen([sys.executable, "-m", "agentrun_cli", "connect", "--state-dir", str(self.state_dir),
                                    "--origin", peer.origin, "--workspace-id", "personal:test", "--device-auth",
                                    "--select", selected["id"], "--yes", "--no-start"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=self.env)
        lines = queue.Queue()
        reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
        reader.start()
        try:
            instructions = json.loads(lines.get(timeout=10))
            self.assertEqual(instructions["user_code"], "ABCD-EFGH")
            peer.token_gate.set()
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, stdout + stderr)
            self.assertEqual(json.loads(stdout)["status"], "connected")
            self.assertEqual(len([request for request in peer.requests if request[1] == "/oauth/token"]), 4)
        finally:
            peer.token_gate.set()
            if process.poll() is None:
                process.kill()
                process.communicate()
            reader.join(timeout=5)

    def test_device_auth_rejects_untrusted_metadata_before_sending_any_device_code(self):
        # Extend the same auth boundary with metadata that could redirect an enrollment grant to another peer.
        peer, target = self.device_peer(), self.peer()
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        metadata = peer.respond("GET", "/api/v2/control/auth/device", None)[1]
        cases = [[], {**metadata, "client_id": "invalid\nclient"},
                 {**metadata, "device_authorization_endpoint": target.origin + "/steal"},
                 {**metadata, "token_endpoint": target.origin + "/steal"},
                 {**metadata, "issuer": "https://provider.example/project"},
                 {**metadata, "device_authorization_endpoint": peer.origin + "/oauth/device#fragment"},
                 {**metadata, "token_endpoint": peer.origin.replace("//", "//user:password@") + "/oauth/token"},
                 {**metadata, "issuer": peer.origin + "/project\n"},
                 {**metadata, "scope": "research:read research:write offline_access"},
                 {**metadata, "verification_uri": "http://console.example.test/device"},
                 {**metadata, "verification_uri": "https://" + "user:secret@" + "console.example.test/device"},
                 {**metadata, "verification_uri": "https://console.example.test/device?redirect=evil"}]
        for metadata_case in cases:
            with self.subTest(metadata=metadata_case):
                peer.requests.clear()
                peer.device_metadata = metadata_case
                result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test", "--device-auth",
                                  "--select", selected["id"], "--yes", "--no-start")
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout)["error"], "device_invalid_response")
                self.assertEqual(len(peer.requests), 1)
                self.assertFalse(target.requests)

    def test_device_auth_rejects_malformed_grants_and_never_follows_provider_redirects(self):
        peer, target = self.device_peer(), self.peer()
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        device = peer.respond("POST", "/oauth/device", {})[1]
        token = peer.respond("POST", "/oauth/token", {})[1]
        cases = [("/oauth/device", 200, [], "device_invalid_response"),
                 ("/api/v2/control/auth/device", -1, {}, "device_invalid_response"),
                 ("/oauth/device", 200, {**device, "user_code": "SECRET\u001b[2J"}, "device_invalid_response"),
                 ("/oauth/device", 200, {**device, "verification_uri": "http://provider.example/verify"}, "device_invalid_response"),
                 ("/oauth/device", 200, {**device, "verification_uri": "http://127.0.0.1:0/verify"}, "device_invalid_response"),
                 ("/oauth/device", 200, {**device, "verification_uri": "https://[invalid"}, "device_invalid_response"),
                 ("/oauth/device", 200, {**device, "interval": True}, "device_invalid_response"),
                 ("/oauth/device", 200, {**device, "expires_in": 0}, "device_invalid_response"),
                 ("/oauth/token", 200, {**token, "access_token": "\n".join(["SECRET", "header"])}, "device_invalid_response"),
                 ("/oauth/token", 200, {**token, "access_token": None}, "device_invalid_response"),
                 ("/oauth/token", 200, {**token, "token_type": "Basic"}, "device_invalid_response"),
                 ("/oauth/token", 200, {**token, "expires_in": None}, "device_invalid_response"),
                 ("/oauth/token", 200, {**token, "expires_in": 0}, "device_invalid_response")]
        cases.extend((path, 302, {"error": "SECRET provider failure"}, "redirect_refused")
                     for path in ["/api/v2/control/auth/device", "/oauth/device", "/oauth/token"])
        peer.redirect_to = target.origin + "/steal"
        for path, status, payload, expected in cases:
            with self.subTest(path=path, payload=payload):
                peer.requests.clear()
                peer.auth_responses = {path: (status, payload)}
                result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test", "--device-auth",
                                  "--select", selected["id"], "--yes", "--no-start")
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout.splitlines()[-1])["error"], expected)
                self.assertFalse(any(request[1].endswith("/connectors") for request in peer.requests))
                self.assertFalse(target.requests)
                self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_device_auth_denial_expiry_and_cancellation_do_not_enroll(self):
        peer = self.device_peer()
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        args = ["connect", "--origin", peer.origin, "--workspace-id", "personal:test", "--device-auth",
                "--select", selected["id"], "--yes", "--no-start"]
        cases = [("/oauth/token", 400, {"error": "access_denied", "error_description": "SECRET details"}, "device_authorization_denied"),
                 ("/oauth/token", 400, {"error": "expired_token"}, "device_authorization_expired"),
                 ("/oauth/device", 400, {"error": "unauthorized_client"}, "device_authorization_unavailable"),
                 ("/api/v2/control/auth/device", 503, {"detail": {"code": "device_authorization_unavailable"}}, "device_authorization_unavailable")]
        device = peer.respond("POST", "/oauth/device", {})[1]
        cases.append(("/oauth/device", 200, {**device, "expires_in": 1, "interval": 5}, "device_authorization_expired"))
        for path, status, payload, expected in cases:
            with self.subTest(expected=expected, path=path):
                peer.requests.clear()
                peer.auth_responses = {path: (status, payload)}
                result = self.cli(*args)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout.splitlines()[-1])["error"], expected)
                self.assertFalse(any(row[1].endswith("/connectors") for row in peer.requests))
                self.assertNotIn("SECRET", result.stdout + result.stderr)
                if path == "/oauth/device" and status == 200:
                    self.assertFalse(any(row[1] == "/oauth/token" for row in peer.requests))
        peer.auth_responses = {}
        peer.requests.clear()
        process = subprocess.Popen([sys.executable, "-m", "agentrun_cli", *args, "--state-dir", str(self.state_dir)],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=self.env)
        lines = queue.Queue()
        reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
        reader.start()
        try:
            self.assertEqual(json.loads(lines.get(timeout=10))["user_code"], "ABCD-EFGH")
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 1, stdout + stderr)
            self.assertEqual(json.loads(stdout)["error"], "device_authorization_cancelled")
            self.assertFalse(any(row[1].endswith("/connectors") for row in peer.requests))
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            reader.join(timeout=5)

    def test_device_auth_retries_transient_poll_failures_without_creating_a_new_grant(self):
        # Token polling must survive dropped connections and provider throttling while retaining one device grant.
        peer = self.device_peer()
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        peer.token_responses = [(0, {}), (503, {"error": "SECRET upstream failure"}), (429, {})]
        result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test", "--device-auth",
                          "--select", selected["id"], "--yes", "--no-start", timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])["status"], "connected")
        grants = [row for row in peer.requests if row[1] == "/oauth/device"]
        polls = [row for row in peer.requests if row[1] == "/oauth/token"]
        self.assertEqual(len(grants), 1)
        self.assertEqual(len(polls), 4)
        self.assertTrue(all(row[3] == polls[0][3] for row in polls))
        self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_device_auth_disconnect_stops_before_denial_and_retries_with_fresh_authorization(self):
        # Disconnect must remain stopped after denied approval and obtain a fresh management token on retry.
        peer = self.device_peer()
        self.enroll(peer)
        peer.token_responses = [(400, {"error": "access_denied"})]
        denied = self.cli("disconnect", "--device-auth")
        self.assertEqual(denied.returncode, 2, denied.stdout + denied.stderr)
        result = json.loads(denied.stdout.splitlines()[-1])
        self.assertEqual(result["status"], "revocation_pending")
        self.assertEqual(result["error"], "device_authorization_denied")
        self.assertFalse(result["observing"])
        self.assertFalse(any(row[0] == "DELETE" for row in peer.requests))
        status = json.loads(self.cli("status").stdout)
        self.assertTrue(status["revocation_pending"])
        self.assertFalse(status["observing"])
        approved = self.cli("disconnect", "--device-auth")
        self.assertEqual(approved.returncode, 0, approved.stdout + approved.stderr)
        self.assertEqual(json.loads(approved.stdout.splitlines()[-1])["status"], "disconnected")
        self.assertEqual(len([row for row in peer.requests if row[1].endswith("/auth/device")]), 2)
        self.assertEqual([row[2] for row in peer.requests if row[0] == "DELETE"], ["Bearer SECRET-access-token"])
        self.assertNotIn("SECRET", denied.stdout + denied.stderr + approved.stdout + approved.stderr)
        for file in self.state_dir.rglob("*"):
            if file.is_file():
                self.assertNotIn(b"SECRET", file.read_bytes())

    def test_daemon_restart_retries_lost_ack_with_same_event_and_excludes_unselected_sources(self):
        # Different process/delivery behavior: catches duplicate events after lost acknowledgements.
        peer = self.peer()
        selected = self.enroll(peer)
        peer.lose_ack = True
        first = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 1)
        second = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        delivered = [request for request in peer.requests if request[1].endswith("/events")]
        self.assertEqual(len(delivered), 2)
        self.assertEqual(delivered[0][3], delivered[1][3])
        self.assertEqual(len(peer.accepted), 1)
        event = next(iter(peer.accepted.values()))
        self.assertEqual(event["source_id"], selected["id"])
        self.assertEqual(event["metadata"], {"harness": "claude", "activity": "working"})
        self.assertEqual(delivered[0][2], "Bearer narrow-connector-test")
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 0)
        self.assertNotIn("/private", json.dumps(delivered))
        self.assertNotIn("SECRET", json.dumps(delivered))

    def test_malformed_success_responses_preserve_pending_metadata_until_valid_acknowledgement(self):
        peer = self.peer()
        self.enroll(peer)
        peer.reject_delivery = True
        self.assertEqual(self.cli("daemon", "start", "--once").returncode, 0)
        original = [request[3] for request in peer.requests if request[1].endswith("/events")][-1]
        peer.reject_delivery = False
        for response in [("/heartbeat", b"{SECRET invalid JSON"),
                         ("/heartbeat", {"selections": [], "selections_revision": []}),
                         ("/heartbeat", {"selections": None, "selections_revision": 2}),
                         ("/events", {"accepted_event_ids": [{}]}), ("/events", {})]:
            with self.subTest(response=response[0], payload=type(response[1]).__name__):
                peer.malformed_response = response
                result = self.cli("daemon", "start", "--once")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                current = json.loads(self.cli("status").stdout)
                self.assertEqual(current["queued_events"], 1)
                self.assertEqual(current["delivery_state"], "unavailable")
                self.assertNotIn("SECRET", result.stdout + result.stderr)
        for acknowledgements in [[], ["not-an-event-in-this-batch"]]:
            with self.subTest(acknowledgements=acknowledgements):
                peer.malformed_response = ("/events", {"accepted_event_ids": acknowledgements})
                before = len([request for request in peer.requests if request[1].endswith("/events")])
                result = self.cli("daemon", "start", "--once")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                after = len([request for request in peer.requests if request[1].endswith("/events")])
                self.assertEqual(after - before, 1, "A response making no progress must stop this drain immediately")
                current = json.loads(self.cli("status").stdout)
                self.assertEqual(current["queued_events"], 1)
                self.assertEqual(current["delivery_state"], "queued")
        peer.malformed_response = None
        self.assertEqual(self.cli("daemon", "start", "--once").returncode, 0)
        delivered = [request[3] for request in peer.requests if request[1].endswith("/events")][-1]
        self.assertEqual(delivered, original)
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 0)

    def pending_observation(self, peer):
        self.enroll(peer)
        peer.reject_delivery = True
        result = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        peer.reject_delivery = False
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 1)
        return [request[3] for request in peer.requests if request[1].endswith("/events")][-1]

    def queue_checkpoint(self):
        with sqlite3.connect(self.state_dir / "queue.sqlite3") as db:
            return (db.execute("SELECT id,source,payload FROM events ORDER BY rowid").fetchall(),
                    db.execute("SELECT name,value FROM counters ORDER BY name").fetchall())

    def assert_truncated_success_retries(self, route):
        peer = self.peer()
        original = self.pending_observation(peer)
        before = self.queue_checkpoint()
        saved = json.loads((self.state_dir / "config.json").read_text())
        peer.truncated_response = (route, 200)
        if route == "/heartbeat":
            peer.selection_override = []  # This valid JSON must not revoke consent from an incomplete message.
        command = [sys.executable, "-I", "-m", "agentrun_cli", "daemon", "start", "--foreground",
                   "--interval", "1", "--state-dir", str(self.state_dir)]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        try:
            deadline = time.monotonic() + 10
            while True:
                if process.poll() is not None:
                    out, err = process.communicate()
                    self.fail(f"The observer exited instead of retaining its retry state: {out}{err}")
                current = json.loads((self.state_dir / "config.json").read_text())
                if current.get("failures", 0) > saved.get("failures", 0):
                    break
                self.assertLess(time.monotonic(), deadline, "The broken response did not reach retry state")
                time.sleep(0.02)
            self.assertTrue(current["observing"])
            self.assertEqual(current["delivery_state"], "unavailable")
            self.assertGreater(current["retry_after_seconds"], 0)
            for field in ["selections", "approved_selections", "selections_revision"]:
                self.assertEqual(current[field], saved[field], field)
            self.assertEqual(self.queue_checkpoint(), before, "No partial response can acknowledge events or advance sequence")
            self.assertIsNone(process.poll(), "The foreground observer remains alive for its scheduled retry")
            stopped = self.cli("daemon", "stop")
            self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
            out, err = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, out + err)
            self.assertNotIn("Traceback", out + err)
        finally:
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=5)
        peer.truncated_response = None
        peer.selection_override = None
        recovered = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(recovered.returncode, 0, recovered.stdout + recovered.stderr)
        self.assertEqual([request[3] for request in peer.requests if request[1].endswith("/events")][-1], original)
        self.assertEqual(len(peer.accepted), 1, "Healthy retry reuses the same event id and sequence")
        status = json.loads(self.cli("status").stdout)
        self.assertEqual((status["queued_events"], status["retry_after_seconds"], status["delivery_state"]), (0, 0, "delivered"))

    def test_truncated_chunked_heartbeat_keeps_observer_alive_and_retries_exact_pending_event(self):
        self.assert_truncated_success_retries("/heartbeat")

    def test_truncated_chunked_ack_keeps_observer_alive_and_retries_exact_pending_event(self):
        self.assert_truncated_success_retries("/events")

    def test_truncated_chunked_unauthorized_heartbeat_still_requires_reconnect(self):
        peer = self.peer()
        self.pending_observation(peer)
        peer.truncated_response = ("/heartbeat", 401)
        result = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        status = json.loads(self.cli("status").stdout)
        self.assertFalse(status["observing"])
        self.assertTrue(status["reconnect_required"])
        self.assertNotIn("credential", json.loads((self.state_dir / "config.json").read_text()))

    def test_truncated_chunked_forbidden_ack_keeps_status_retry_after_and_pending_event(self):
        peer = self.peer()
        original = self.pending_observation(peer)
        before = self.queue_checkpoint()
        peer.retry_after = "17"
        peer.truncated_response = ("/events", 403)
        result = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        status = json.loads(self.cli("status").stdout)
        self.assertTrue(status["observing"])
        self.assertEqual((status["delivery_state"], status["retry_after_seconds"], status["queued_events"]),
                         ("configuration_refresh_required", 17, 1))
        self.assertEqual(self.queue_checkpoint(), before)
        peer.truncated_response = None
        recovered = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(recovered.returncode, 0, recovered.stdout + recovered.stderr)
        self.assertEqual([request[3] for request in peer.requests if request[1].endswith("/events")][-1], original)
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 0)

    def test_codex_reads_existing_selected_thread_without_resuming_or_uploading_summary(self):
        # A real Unix WebSocket peer catches protocol drift and accidental history/resume requests.
        calls = []
        fail_later_page = False
        row = {"id": "native-codex-thread", "sessionId": "shared-root", "cwd": "/private/codex",
               "name": "SECRET name", "preview": "SECRET transcript", "path": "/private/rollout.jsonl",
               "status": {"type": "active", "activeFlags": ["waitingOnApproval"]}, "turns": []}
        listing_rows = [row]
        unreadable_threads = set()

        def handle(socket):
            for message in socket:
                value = json.loads(message)
                calls.append(value)
                if "id" not in value:
                    continue
                result = {"userAgent": "codex/0.160.1"}
                if value["method"] == "thread/list":
                    if fail_later_page and value["params"].get("cursor"):
                        socket.close()
                        return
                    result = {"data": listing_rows, "nextCursor": "later-page" if fail_later_page else None}
                elif value["method"] == "thread/read":
                    native = value["params"]["threadId"]
                    if native in unreadable_threads:
                        socket.send(json.dumps({"id": value["id"], "error": {"code": -32602, "message": "Thread not found"}}))
                        continue
                    result = {"thread": next(item for item in listing_rows if item["id"] == native)}
                socket.send(json.dumps({"id": value["id"], "result": result}))

        socket_path = str(self.home / "codex.sock")
        server = unix_serve(handle, socket_path)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.fake_executable("codex", "print(" + repr(json.dumps({"status": "running", "socketPath": socket_path,
                              "appServerVersion": "0.160.1"})) + ")")
        candidates = json.loads(self.cli("discover").stdout)["sessions"]
        codex = [candidate for candidate in candidates if candidate["harness"] == "codex"]
        self.assertEqual(len(codex), 1)
        peer = self.peer()
        connected = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                             "--credential-file", self.credential(peer.origin), "--select", codex[0]["id"], "--yes", "--no-start")
        self.assertEqual(connected.returncode, 0, connected.stdout)
        calls.clear()
        run = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(run.returncode, 0, run.stdout)
        reads = [call for call in calls if call["method"] == "thread/read"]
        self.assertEqual([read["params"] for read in reads], [{"threadId": "native-codex-thread", "includeTurns": False}])
        self.assertFalse(any(call["method"] in {"thread/list", "thread/resume", "thread/start"} for call in calls))
        event = next(iter(peer.accepted.values()))
        self.assertEqual(event["metadata"], {"activity": "waiting_input", "harness": "codex"})
        self.assertNotIn("SECRET", json.dumps(peer.requests))
        for malformed in [{"type": {}}, {"type": "active", "activeFlags": None}, {"type": "active", "activeFlags": [{}]}]:
            with self.subTest(malformed_status=malformed):
                row["status"] = malformed
                run = self.cli("daemon", "start", "--foreground", "--once")
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                latest = max(peer.accepted.values(), key=lambda event: event["sequence"])
                self.assertEqual(latest["metadata"]["activity"], "unknown")
        fail_later_page = True
        partial = self.cli("discover")
        self.assertEqual(partial.returncode, 0, partial.stdout + partial.stderr)
        payload = json.loads(partial.stdout)
        self.assertEqual(len([candidate for candidate in payload["sessions"] if candidate["harness"] == "codex"]), 1)
        diagnostic = next(adapter for adapter in payload["adapters"] if adapter["harness"] == "codex")
        self.assertEqual(diagnostic["status"], "partial")
        self.assertEqual(diagnostic["reason"], "transport_unavailable")
        self.assertNotIn("SECRET", partial.stdout + partial.stderr)
        fail_later_page = False
        row["status"] = {"type": "active", "activeFlags": []}
        listing_rows.append({**row, "id": "native-codex-second"})
        discovered = json.loads(self.cli("discover").stdout)["sessions"]
        selected = [candidate["id"] for candidate in discovered if candidate["harness"] == "codex"]
        connected = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                             "--credential-file", self.credential(peer.origin), "--select", selected[0],
                             "--select", selected[1], "--yes", "--no-start")
        self.assertEqual(connected.returncode, 0, connected.stdout + connected.stderr)
        for failed_index in [1, 0]:
            with self.subTest(unreadable_selected_index=failed_index):
                unreadable_threads = {listing_rows[failed_index]["id"]}
                peer.accepted.clear()
                observed = self.cli("daemon", "start", "--once")
                self.assertEqual(observed.returncode, 0, observed.stdout + observed.stderr)
                activities = {event["external_session_id"]: event["metadata"]["activity"] for event in peer.accepted.values()}
                self.assertEqual(activities, {selected[failed_index]: "unknown", selected[1 - failed_index]: "working"})
                self.assertNotIn("SECRET", json.dumps(peer.requests))

    def test_background_start_is_singleton_and_stop_preserves_connection_without_trusting_pid(self):
        # A real second daemon process catches duplicate collectors and PID-only liveness.
        peer = self.peer()
        self.enroll(peer)
        marker = self.hostile_pythonpath()
        first = self.cli("daemon", "start", "--interval", "3600")
        self.addCleanup(lambda: self.cli("daemon", "stop"))
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        live = json.loads(self.cli("status").stdout)
        self.assertEqual(live["daemon"], "running")
        duplicate = self.cli("daemon", "start")
        self.assertEqual(json.loads(duplicate.stdout)["status"], "already_running")
        stopped = self.cli("daemon", "stop")
        self.assertEqual(stopped.returncode, 0, stopped.stdout)
        after = json.loads(self.cli("status").stdout)
        self.assertEqual(after["daemon"], "stopped")
        self.assertEqual(after["connector_id"], "connector-test")
        self.assertTrue(after["observing"])
        self.assertFalse(any(request[0] == "DELETE" for request in peer.requests))
        stale = self.home / "state" / "daemon.pid"
        stale.write_text(str(os.getpid()))
        self.assertEqual(json.loads(self.cli("daemon", "stop").stdout)["status"], "stopped")
        self.assertEqual(json.loads(self.cli("status").stdout)["daemon"], "stopped")
        self.assertFalse(marker.exists())

    def test_future_sessions_require_explicit_project_or_harness_subscription(self):
        # Different enrollment meaning: session choice cannot silently expand to future sessions.
        for mode, expected in [("session", 1), ("project", 2), ("harness", 3)]:
            with self.subTest(mode=mode):
                self.state_dir = self.home / mode
                peer = self.peer()
                rows = json.loads(self.cli("discover").stdout)["sessions"]
                selected = rows[0]
                flag, value = {"session": ("--select", selected["id"]),
                               "project": ("--subscribe-project", selected["project_id"]),
                               "harness": ("--subscribe-harness", "claude")}[mode]
                connected = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                                     "--credential-file", self.credential(peer.origin), flag, value, "--yes", "--no-start")
                self.assertEqual(connected.returncode, 0, connected.stdout + connected.stderr)
                raw = json.loads(self.sessions.read_text())[:2]
                raw.append({"sessionId": "future-session", "cwd": "/private/client-a", "status": "busy"})
                self.sessions.write_text(json.dumps(raw))
                run = self.cli("daemon", "start", "--foreground", "--once")
                self.assertEqual(run.returncode, 0, run.stdout)
                self.assertEqual(len(peer.accepted), expected)
                selection = peer.connector["selections"][0]
                self.assertEqual(selection["mode"], mode)
                self.assertEqual(selection["include_future_sessions"], mode != "session")
                self.assertNotIn("/private", json.dumps(peer.requests))
                # Each mode is a distinct temporary installation, through the public config-dir option.
                self.cli("daemon", "stop")
                self.sessions.write_text(json.dumps(raw[:2]))

    def test_remote_removal_or_widening_cannot_send_previously_queued_source(self):
        # Extends delivery safety with host-side edits; pending metadata must obey latest consent.
        for change in ["removed", "widened", "rebound"]:
            with self.subTest(change=change):
                self.state_dir = self.home / change
                peer = self.peer()
                self.enroll(peer)
                peer.lose_ack = True
                self.cli("daemon", "start", "--foreground", "--once")
                altered = dict(peer.connector["selections"][0])
                if change == "widened":
                    altered.update(mode="harness", external_session_id=None, include_future_sessions=True)
                if change == "rebound":
                    altered.update(external_session_id="different-session")
                peer.selection_override = [] if change == "removed" else [altered]
                peer.requests.clear()
                result = self.cli("daemon", "start", "--foreground", "--once")
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertFalse(any(request[1].endswith("/events") for request in peer.requests))
                self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 0)

    def test_fresh_observations_refresh_activity_with_bounded_backlog_and_malformed_input_becomes_unknown(self):
        # Adds distinct offline-cap behavior; a configurable zero refresh interval avoids sleeps.
        peer = self.peer()
        self.enroll(peer, "--queue-limit", "2", "--refresh-seconds", "0")
        peer.reject_delivery = True
        for _ in range(3):
            result = self.cli("daemon", "start", "--foreground", "--once")
            self.assertEqual(result.returncode, 0, result.stdout)
        status = json.loads(self.cli("status").stdout)
        self.assertEqual(status["queued_events"], 2)
        self.assertEqual(status["dropped_events"], 1)
        peer.reject_delivery = False
        self.sessions.write_text("{partially-written SECRET")
        delivered = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(delivered.returncode, 0, delivered.stdout)
        events = sorted(peer.accepted.values(), key=lambda event: event["sequence"])
        self.assertEqual([event["sequence"] for event in events], [3, 4])
        self.assertEqual(events[-1]["metadata"]["activity"], "unknown")
        self.assertEqual(json.loads(self.cli("status").stdout)["dropped_events"], 2)
        self.assertNotIn("SECRET", json.dumps(peer.requests) + delivered.stdout + delivered.stderr)

    def test_hosted_revocation_stops_credential_retries_and_local_offline_disconnect_remains_pending(self):
        # Distinct terminal credential lifecycle, observed through daemon/management commands and HTTP.
        for action in ["hosted", "offline_local"]:
            with self.subTest(action=action):
                self.state_dir = self.home / action
                peer = self.peer()
                self.enroll(peer)
                if action == "hosted":
                    peer.revoked = True
                    result = self.cli("daemon", "start", "--foreground", "--once")
                    self.assertEqual(json.loads(result.stdout)["status"], "reconnect_required")
                else:
                    peer.delete_fails = True
                    result = self.cli("disconnect", "--credential-file", self.credential(peer.origin))
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(json.loads(result.stdout)["status"], "revocation_pending")
                self.assertFalse(json.loads(self.cli("status").stdout)["observing"])
                peer.requests.clear()
                self.assertNotEqual(self.cli("daemon", "start", "--foreground", "--once").returncode, 0)
                self.assertEqual(peer.requests, [])
                if action == "offline_local":
                    peer.delete_fails = False
                    done = self.cli("disconnect", "--credential-file", self.credential(peer.origin))
                    self.assertEqual(done.returncode, 0, done.stdout)
                    self.assertEqual(json.loads(done.stdout)["status"], "disconnected")
                    self.assertTrue(peer.revoked)

    def test_reenrollment_recovers_one_time_credential_and_cannot_repoint_connected_origin(self):
        # Same installation replay is a distinct auth path; initial privacy test cannot exercise it.
        peer = self.peer()
        selected = self.enroll(peer)
        enrollment = next(request[3] for request in peer.requests if request[1].endswith("/connectors"))
        again = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                         "--credential-file", self.credential(peer.origin), "--select", selected["id"], "--yes", "--no-start")
        self.assertEqual(again.returncode, 0, again.stdout)
        enrollments = [request[3] for request in peer.requests if request[1].endswith("/connectors")]
        self.assertEqual({request["installation_id"] for request in enrollments}, {enrollment["installation_id"]})
        self.assertEqual(len([request for request in peer.requests if "/rotate-credential" in request[1]]), 1)
        self.cli("daemon", "start", "--foreground", "--once")
        heartbeat = next(request for request in peer.requests if request[1].endswith("/heartbeat"))
        self.assertEqual(heartbeat[2], "Bearer narrow-rotated-test")
        other = self.peer()
        mismatch = self.cli("connect", "--origin", other.origin, "--workspace-id", "personal:test",
                            "--credential-file", self.credential(other.origin), "--select", selected["id"], "--yes", "--no-start")
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertEqual(other.requests, [])

    def test_credentials_require_private_origin_binding_and_never_follow_redirects(self):
        # Extend the enrollment boundary with adversarial credential and transport inputs.
        selected = json.loads(self.cli("discover").stdout)["sessions"][0]
        for failure in ["wrong_origin", "world_readable", "symlink", "redirect", "implicit_selection"]:
            with self.subTest(failure=failure):
                peer, target = self.peer(), self.peer()
                file = Path(self.credential(target.origin if failure == "wrong_origin" else peer.origin))
                if failure == "world_readable":
                    file.chmod(0o644)
                if failure == "symlink":
                    link = self.home / "linked-secret"
                    link.symlink_to(file)
                    file = link
                if failure == "redirect":
                    peer.redirect_to = target.origin + "/steal"
                args = [] if failure == "implicit_selection" else ["--select", selected["id"]]
                result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                                  "--credential-file", str(file), "--yes", "--no-start", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(target.requests, [])
                self.assertFalse(any(request[0] == "POST" for request in peer.requests))
                self.assertNotIn("SECRET", result.stdout + result.stderr)
                self.assertNotIn("broad-secret", result.stdout + result.stderr)
                self.assertIn("error", json.loads(result.stdout))

    def test_rate_limit_retains_backlog_and_exposes_retry_after_without_revoking(self):
        # Time-independent public status checks the scheduling policy without sleeping.
        peer = self.peer()
        self.enroll(peer)
        peer.rate_limit = True
        self.cli("daemon", "start", "--foreground", "--once")
        status = json.loads(self.cli("status").stdout)
        self.assertTrue(status["observing"])
        self.assertEqual(status["queued_events"], 1)
        self.assertEqual(status["retry_after_seconds"], 120)
        self.assertEqual(status["delivery_state"], "rate_limited")
        self.assertEqual(len([request for request in peer.requests if request[1].endswith("/events")]), 1)
        peer.rate_limit = False
        self.cli("daemon", "start", "--foreground", "--once")
        recovered = json.loads(self.cli("status").stdout)
        self.assertEqual(recovered["queued_events"], 0)
        self.assertEqual(recovered["retry_after_seconds"], 0)

    def test_login_startup_is_opt_in_and_can_be_removed_without_revoking(self):
        # External service-manager executable is the boundary; never installs a host login service.
        peer = self.peer()
        self.enroll(peer)
        calls = self.home / "service-calls.jsonl"
        self.env["SERVICE_CALLS"] = str(calls)
        self.fake_executable("systemctl", "import os,json,sys\nwith open(os.environ['SERVICE_CALLS'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')")
        before = self.cli("startup", "status")
        self.assertEqual(before.returncode, 0, before.stdout + before.stderr)
        self.assertFalse(json.loads(before.stdout)["enabled"])
        self.assertFalse(calls.exists())
        enabled = self.cli("startup", "enable")
        self.assertEqual(enabled.returncode, 0, enabled.stdout + enabled.stderr)
        self.assertTrue(json.loads(self.cli("startup", "status").stdout)["enabled"])
        service = next((self.home / ".config/systemd/user").glob("agentrun-*.service")).read_text()
        command = next(line.removeprefix("ExecStart=") for line in service.splitlines() if line.startswith("ExecStart="))
        marker = self.hostile_pythonpath()
        observed = subprocess.run([*shlex.split(command), "--once"], env=self.env,
                                  capture_output=True, text=True, timeout=15)
        self.assertEqual(observed.returncode, 0, observed.stdout + observed.stderr)
        self.assertTrue(peer.accepted)
        self.assertFalse(marker.exists())
        disabled = self.cli("startup", "disable")
        self.assertEqual(disabled.returncode, 0, disabled.stdout + disabled.stderr)
        self.assertFalse(json.loads(self.cli("startup", "status").stdout)["enabled"])
        invocations = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertTrue(any("enable" in argv for argv in invocations))
        self.assertTrue(any("disable" in argv for argv in invocations))
        self.assertFalse(any(request[0] == "DELETE" for request in peer.requests))

    def test_interactive_connect_authenticates_workspace_before_discovering_and_confirming_sources(self):
        # External executable marker checks walkthrough ordering, not an internal function call.
        peer = self.peer()
        marker = self.home / "harness-was-read"
        self.env["HARNESS_MARKER"] = str(marker)
        self.fake_executable("claude", "import os,pathlib\npathlib.Path(os.environ['HARNESS_MARKER']).touch()\nprint(pathlib.Path(os.environ['HARNESS_ROWS']).read_text())")
        rejected = self.cli("connect", "--origin", peer.origin, "--workspace-id", "not-authorized",
                            "--credential-file", self.credential(peer.origin), input="y\n1\ny\n")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse(marker.exists())
        original_sessions = self.sessions.read_text()
        self.sessions.write_text("[]")
        empty = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                         "--credential-file", self.credential(peer.origin), "--no-start", input="y\n")
        self.assertEqual(empty.returncode, 1, empty.stdout + empty.stderr)
        self.assertIn('"error": "no_supported_sessions"', empty.stdout)
        self.assertFalse(any(request[0] == "POST" for request in peer.requests))
        self.sessions.write_text(original_sessions)
        connected = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                             "--credential-file", self.credential(peer.origin), "--no-start", input="y\n1\ny\n")
        self.assertEqual(connected.returncode, 0, connected.stdout + connected.stderr)
        self.assertEqual(len(peer.connector["selections"]), 1)
        self.assertFalse(peer.connector["selections"][0]["include_future_sessions"])

    def test_lost_enrollment_response_reuses_operation_only_for_identical_approved_request(self):
        # Recovery must handle changed consent after an ambiguous enrollment response.
        for changed in [False, True]:
            with self.subTest(changed=changed):
                self.state_dir = self.home / str(changed)
                peer = self.peer()
                rows = json.loads(self.cli("discover").stdout)["sessions"]
                credential = self.credential(peer.origin)
                peer.lose_registration = True
                arguments = ("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                             "--credential-file", credential, "--yes", "--no-start")
                failed = self.cli(*arguments, "--select", rows[0]["id"])
                self.assertNotEqual(failed.returncode, 0)
                recovered = self.cli(*arguments, "--select", rows[1 if changed else 0]["id"])
                self.assertEqual(recovered.returncode, 0, recovered.stdout)
                enrollments = [request[3] for request in peer.requests if request[1].endswith("/connectors")]
                self.assertEqual(enrollments[0]["operation_id"] == enrollments[1]["operation_id"], not changed)

    def test_disconnect_purges_pending_metadata_before_reusing_installation_at_another_destination(self):
        # Cross-destination backlog must not escape when the same local session is selected again.
        first = self.peer()
        selected = self.enroll(first)
        first.reject_delivery = True
        self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 1)
        old_event = next(request[3]["events"][0] for request in first.requests if request[1].endswith("/events"))
        disconnected = self.cli("disconnect", "--credential-file", self.credential(first.origin))
        self.assertEqual(disconnected.returncode, 0, disconnected.stdout)
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 0)
        second = self.peer()
        connected = self.cli("connect", "--origin", second.origin, "--workspace-id", "personal:test",
                             "--credential-file", self.credential(second.origin), "--select", selected["id"], "--yes", "--no-start")
        self.assertEqual(connected.returncode, 0, connected.stdout)
        self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(len(second.accepted), 1)
        self.assertNotIn(old_event["event_id"], second.accepted)

    def test_returning_to_a_previous_destination_keeps_its_session_sequence_ahead(self):
        first = self.peer(); self.enroll(first, "--refresh-seconds", "0")
        for _ in range(3):
            sent = self.cli("daemon", "start", "--foreground", "--once")
            self.assertEqual(sent.returncode, 0, sent.stdout + sent.stderr)
        retained_sequence = max(event["sequence"] for event in first.accepted.values())
        first.reject_delivery = True
        self.cli("daemon", "start", "--foreground", "--once")
        pending = next(request[3]["events"][0] for request in reversed(first.requests) if request[1].endswith("/events"))
        self.assertEqual(json.loads(self.cli("disconnect", "--credential-file", self.credential(first.origin)).stdout)["status"], "disconnected")
        self.assertEqual(json.loads(self.cli("status").stdout)["queued_events"], 0)
        second = self.peer(); self.enroll(second, "--refresh-seconds", "0")
        self.assertEqual(self.cli("daemon", "start", "--foreground", "--once").returncode, 0)
        self.assertEqual(json.loads(self.cli("disconnect", "--credential-file", self.credential(second.origin)).stdout)["status"], "disconnected")
        first.reject_delivery = False; self.enroll(first, "--refresh-seconds", "0")
        rows = json.loads(self.sessions.read_text()); rows[0]["status"] = "idle"; self.sessions.write_text(json.dumps(rows))
        delivered = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(delivered.returncode, 0, delivered.stdout + delivered.stderr)
        updates = [event for event in first.accepted.values() if event["metadata"]["activity"] == "idle"]
        self.assertEqual(len(updates), 1)
        self.assertGreater(updates[0]["sequence"], retained_sequence, "a receiver retaining its old maximum must apply this first update")
        self.assertNotIn(pending["event_id"], first.accepted)
        self.assertNotIn(pending["event_id"], second.accepted)

    def test_structured_malformed_claude_rows_do_not_drop_a_valid_selected_observation(self):
        # One malformed unselected record must not crash collection of the approved source.
        peer = self.peer()
        self.enroll(peer, "--refresh-seconds", "0")
        valid = json.loads(self.sessions.read_text())[0]
        for malformed in [{"status": {}}, {"status": []}, {"state": []}]:
            with self.subTest(malformed=malformed):
                self.sessions.write_text(json.dumps([{"sessionId": "bad", "cwd": "/private/bad", **malformed}, valid]))
                run = self.cli("daemon", "start", "--foreground", "--once")
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(len(peer.accepted), 3)
        self.assertEqual({event["metadata"]["activity"] for event in peer.accepted.values()}, {"working"})


if __name__ == "__main__":
    unittest.main()
