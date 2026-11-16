"""Harness results and delivery settlement keep their original consent epoch."""

import fcntl
import json
import os
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch

from agentrun_cli import daemon
from agentrun_cli.network import APIError
from agentrun_cli.state import State
import test_cli_process as fixtures
import test_consent_lifecycle as consent
import test_heartbeat_epoch as heartbeat


class ObservationPeer(fixtures.LifecyclePeer):
    def __init__(self, rows, same_credential):
        self.rows = rows
        self.same_credential = same_credential
        self.armed = False
        self.registration_held = False
        self.harness_held = False
        self.registration_entered = threading.Event()
        self.registration_release = threading.Event()
        self.harness_entered = threading.Event()
        self.harness_release = threading.Event()
        self.fresh_heartbeat = threading.Event()
        self.finished_enrollment = False
        super().__init__("none")

    def respond(self, method, path, body, headers=None):
        if path == "/harness":
            rows = json.loads(self.rows.read_text())
            if self.registration_held and not self.harness_held:
                self.harness_held = True
                self.harness_entered.set()
                if not self.harness_release.wait(8):
                    return 503, {"detail": {"code": "test_gate_expired"}}
            return 200, rows
        code, payload = super().respond(method, path, body, headers)
        if self.armed and "/rotate-credential" in path and code == 200 and self.same_credential:
            self.active_credential = self.old_credential
            payload["credential"] = self.old_credential
        if self.armed and path.endswith("/connectors") and code == 409 and not self.registration_held:
            self.registration_held = True
            self.registration_entered.set()
            if not self.registration_release.wait(8):
                return 503, {"detail": {"code": "test_gate_expired"}}
        if self.finished_enrollment and path.endswith("/heartbeat"):
            self.fresh_heartbeat.set()
        return code, payload


class ObservationEpochTests(unittest.TestCase):
    setUp = fixtures.CliProcessTests.setUp
    fake_executable = fixtures.CliProcessTests.fake_executable
    cli = fixtures.CliProcessTests.cli
    credential = fixtures.CliProcessTests.credential
    connect = consent.ConsentLifecycleTests.connect
    queued = consent.ConsentLifecycleTests.queued
    queue_checkpoint = fixtures.CliProcessTests.queue_checkpoint
    competing_cli = fixtures.CliProcessTests.competing_cli
    completed_cli = fixtures.CliProcessTests.completed_cli
    direct = heartbeat.HeartbeatEpochTests.direct

    def blocked_harness_reconnect(self, same_credential):
        peer = ObservationPeer(self.sessions, same_credential)
        self.addCleanup(peer.close)
        self.env["HARNESS_PEER"] = peer.origin
        self.fake_executable("claude", "import os,urllib.request\nprint(urllib.request.urlopen(os.environ['HARNESS_PEER']+'/harness',timeout=10).read().decode())")
        sources = json.loads(self.cli("discover").stdout)["sessions"]
        self.connect(peer, sources)
        peer.reject_delivery = True
        self.assertEqual(self.cli("daemon", "start", "--foreground", "--once").returncode, 0)
        before = self.queue_checkpoint()
        retained = next(event for event in self.queued() if event["source_id"] == sources[1]["id"])
        peer.old_credential = peer.active_credential
        peer.armed = True
        connecting = self.competing_cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                                        "--credential-file", self.credential(peer.origin), "--select", sources[1]["id"],
                                        "--yes", "--no-start")
        try:
            self.assertTrue(peer.registration_entered.wait(5), "reconnect has stopped the old daemon before enrollment")
            started = self.cli("daemon", "start", "--interval", "3600")
            self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
            self.assertTrue(peer.harness_entered.wait(5), "the independent installed daemon is blocked reading actual CLI rows")
            peer.registration_release.set()
            self.completed_cli(connecting)
            committed = State(self.state_dir).data
            self.assertEqual(committed["credential"] == peer.old_credential, same_credential)
            self.assertEqual(self.queued(), [retained])
            event_requests = sum(path.endswith("/events") for _, path, _, _ in peer.requests)
            peer.finished_enrollment = True
            peer.harness_release.set()
            continued = peer.fresh_heartbeat.wait(3)
            stopped = self.cli("daemon", "stop")
            self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
            delivered = [body for _, path, _, body in peer.requests if path.endswith("/events")][event_requests:]
            self.assertTrue(all(event["source_id"] == sources[1]["id"] for body in delivered for event in body["events"]), json.dumps(delivered))
            self.assertEqual(self.queue_checkpoint()[1], before[1], "a stale discovery allocates no observation sequence")
            self.assertEqual(self.queued(), [retained], "removed-source payload cannot return after enrollment pruned it")
            saved = State(self.state_dir).data
            for field in ["credential", "selections_revision", "approved_selections", "selections", "observing"]:
                self.assertEqual(saved[field], committed[field], field)
            self.assertTrue(all(body["selections_revision"] == committed["selections_revision"] for body in delivered))
            self.assertTrue(continued, "the stale cycle retries the current consent without the 3600-second delay")
        finally:
            peer.registration_release.set()
            peer.harness_release.set()
            self.cli("daemon", "stop")

    def test_blocked_discovery_cannot_reinsert_removed_source_with_same_credential_and_new_revision(self):
        self.blocked_harness_reconnect(True)

    def test_blocked_discovery_cannot_reinsert_removed_source_after_credential_rotation(self):
        self.blocked_harness_reconnect(False)

    def candidate(self):
        return SimpleNamespace(id="A", harness="claude", project_id="project", activity="finished")

    def renew(self, queue, **fields):
        writer = State(self.state_dir)
        selected = fields.get("selections", writer.data["selections"])
        writer.complete_connection(fields, lambda _latest: queue.retain_sources({s["source_id"] for s in selected}))

    def test_every_consent_and_connection_field_is_rechecked_after_discovery(self):
        changes = {"selections_revision": 2, "credential": "test-key", "origin": "http://127.0.0.1:2",
                   "workspace_id": "personal:other", "connector_id": "connector-other",
                   "observing": False, "approved_selections": [],
                   "selections": [{"source_id": "A", "harness": "claude", "mode": "session",
                                   "external_session_id": "changed-session", "include_future_sessions": False}]}
        for field, value in changes.items():
            with self.subTest(field=field):
                self.state_dir = self.home / field
                state, queue, selected = self.direct()
                before = queue.batch()
                sent = []

                def response(_origin, _token, _method, path, body):
                    if path.endswith("/heartbeat"):
                        return {"selections": selected, "selections_revision": 1}
                    sent.append(body)
                    return {"accepted_event_ids": []}

                def observed(*args, **kwargs):
                    self.renew(queue, **{field: value})
                    # observe's metadata save really reloads current consent; it is not authorization.
                    state.data["discovery_diagnostics"] = [{"harness": "claude", "status": "available"}]
                    state.save()
                    return [self.candidate()]

                with patch.object(daemon, "request", response), patch.object(daemon, "observe", observed):
                    self.assertEqual(daemon.tick(state, queue), "connection_changed")
                self.assertEqual(queue.batch(), [e for e in before if any(s["source_id"] == e["source_id"] for s in State(self.state_dir).data["selections"])])
                self.assertEqual(queue.db.execute("SELECT value FROM counters WHERE name='sequence'").fetchone()[0], 2)
                self.assertEqual(sent, [])
                self.assertEqual(state.data, State(self.state_dir).data)

    def test_partial_discovery_without_a_metadata_save_is_also_fenced(self):
        state, queue, selected = self.direct()
        before = queue.batch()

        def observed(*args, **kwargs):
            self.renew(queue, selections_revision=2)
            return [self.candidate()]

        def response(_origin, _token, _method, path, _body):
            return {"selections": selected, "selections_revision": 1} if path.endswith("/heartbeat") else {"accepted_event_ids": []}

        with patch.object(daemon, "request", response), patch.object(daemon, "observe", observed):
            self.assertEqual(daemon.tick(state, queue), "connection_changed")
        self.assertEqual(queue.batch(), before)

    def test_current_and_metadata_only_changes_still_enqueue_and_deliver_with_diagnostics(self):
        state, queue, selected = self.direct()
        delivered = []

        def observed(*args, **kwargs):
            writer = State(self.state_dir)
            writer.data["unrelated_metadata"] = "kept"
            writer.save()
            state.data["discovery_diagnostics"] = [{"harness": "claude", "status": "partial", "reason": "candidate_limit"}]
            state.save()
            return [self.candidate()]

        def response(_origin, _token, _method, path, body):
            if path.endswith("/heartbeat"):
                return {"selections": selected, "selections_revision": 1}
            delivered.append(body)
            return {"accepted_event_ids": [event["event_id"] for event in body["events"]]}

        with patch.object(daemon, "request", response), patch.object(daemon, "observe", observed):
            self.assertEqual(daemon.tick(state, queue), "delivered")
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0]["selections_revision"], 1)
        self.assertEqual(len(delivered[0]["events"]), 3)
        self.assertEqual(queue.batch(), [])
        self.assertEqual(state.data["unrelated_metadata"], "kept")
        self.assertEqual(state.data["discovery_diagnostics"][0]["reason"], "candidate_limit")

    def test_queue_writes_batch_admission_and_acknowledgment_hold_the_config_lock(self):
        state, queue, selected = self.direct()
        held = []

        def checked(name, call):
            def invoke(*args, **kwargs):
                fd = os.open(self.state_dir / "config.lock", os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError, msg=name + " must serialize with enrollment"):
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(fd)
                held.append(name)
                return call(*args, **kwargs)
            return invoke

        def response(_origin, _token, _method, path, body):
            if path.endswith("/heartbeat"):
                return {"selections": selected, "selections_revision": 1}
            return {"accepted_event_ids": [event["event_id"] for event in body["events"]]}

        with patch.object(daemon, "request", response), patch.object(daemon, "observe", return_value=[self.candidate()]), patch.object(queue, "observe", checked("observe", queue.observe)), patch.object(queue, "batch", checked("batch", queue.batch)), patch.object(queue, "acknowledge", checked("acknowledge", queue.acknowledge)):
            self.assertEqual(daemon.tick(state, queue), "delivered")
        self.assertIn("observe", held)
        self.assertIn("batch", held)
        self.assertIn("acknowledge", held)

    def test_old_delivery_ack_cannot_remove_new_consent_pending_events_or_overwrite_status(self):
        state, queue, selected = self.direct()
        retained = queue.batch()[1]

        def response(_origin, _token, _method, path, body):
            if path.endswith("/heartbeat"):
                return {"selections": selected, "selections_revision": 1}
            self.renew(queue, selections=selected[1:], approved_selections=selected[1:], selections_revision=2,
                       delivery_state="new enrollment", retry_after_seconds=0, failures=0)
            return {"accepted_event_ids": [event["event_id"] for event in body["events"]]}

        with patch.object(daemon, "request", response), patch.object(daemon, "observe", return_value=[]):
            self.assertEqual(daemon.tick(state, queue), "connection_changed")
        self.assertEqual(queue.batch(), [retained])
        self.assertEqual(state.data["delivery_state"], "new enrollment")
        self.assertEqual(state.data, State(self.state_dir).data)

    def test_old_delivery_failure_does_not_backoff_or_relabel_new_consent(self):
        for error in [APIError(429, {}, retry_after=120), OSError("fixture delivery unavailable")]:
            with self.subTest(error=type(error).__name__):
                self.state_dir = self.home / type(error).__name__
                state, queue, selected = self.direct()

                def response(_origin, _token, _method, path, _body):
                    if path.endswith("/heartbeat"):
                        return {"selections": selected, "selections_revision": 1}
                    self.renew(queue, selections_revision=2, delivery_state="new enrollment", retry_after_seconds=0, failures=0)
                    raise error

                with patch.object(daemon, "request", response), patch.object(daemon, "observe", return_value=[]):
                    self.assertEqual(daemon.tick(state, queue), "connection_changed")
                self.assertEqual(state.data["delivery_state"], "new enrollment")
                self.assertEqual(state.data["failures"], 0)
                self.assertEqual(state.data["retry_after_seconds"], 0)

    def test_old_offline_heartbeat_cannot_start_discovery_using_new_consent_and_old_destination(self):
        state, queue, _selected = self.direct()
        before = queue.batch()

        def response(*args):
            self.renew(queue, origin="http://127.0.0.1:2", selections_revision=2, credential="test-key",
                       delivery_state="new enrollment", retry_after_seconds=0, failures=0)
            raise OSError("fixture heartbeat unavailable")

        with patch.object(daemon, "request", response), patch.object(daemon, "observe") as observe:
            self.assertEqual(daemon.tick(state, queue), "connection_changed")
            observe.assert_not_called()
        self.assertEqual(queue.batch(), before)
        self.assertEqual(state.data["delivery_state"], "new enrollment")
