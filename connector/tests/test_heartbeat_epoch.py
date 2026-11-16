"""A successful response belongs to its request's connection and consent epoch."""

import copy
import fcntl
import json
import os
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch

from agentrun_cli import cli, daemon
from agentrun_cli.queue import Queue
from agentrun_cli.state import State
import test_cli_process as fixtures
import test_consent_lifecycle as consent


class SuccessfulEpochPeer(fixtures.LifecyclePeer):
    def __init__(self, same_credential=False):
        self.same_credential = same_credential
        self.armed = False
        self.registration_held = False
        self.heartbeat_held = False
        self.registration_entered = threading.Event()
        self.registration_release = threading.Event()
        self.heartbeat_entered = threading.Event()
        self.heartbeat_release = threading.Event()
        self.fresh_heartbeat = threading.Event()
        self.fresh_events = threading.Event()
        self.finished_enrollment = False
        super().__init__("none")

    def arm(self):
        self.old_credential = self.active_credential
        # The old server epoch really removed consent before answering the held heartbeat.
        self.connector.update(selections=[], selections_revision=self.connector["selections_revision"] + 1)
        self.armed = True

    def respond(self, method, path, body, headers=None):
        code, payload = super().respond(method, path, body, headers)
        if self.armed and "/rotate-credential" in path and code == 200 and self.same_credential:
            self.active_credential = self.old_credential
            payload["credential"] = self.old_credential
        if self.armed and path.endswith("/connectors") and code == 409 and not self.registration_held:
            self.registration_held = True
            self.registration_entered.set()
            if not self.registration_release.wait(8):
                return 503, {"detail": {"code": "test_gate_expired"}}
        if self.armed and path.endswith("/heartbeat") and code == 200 and not self.heartbeat_held:
            self.heartbeat_held = True
            payload = copy.deepcopy(payload)
            self.heartbeat_entered.set()
            if not self.heartbeat_release.wait(8):
                return 503, {"detail": {"code": "test_gate_expired"}}
        elif self.finished_enrollment and code == 200:
            if path.endswith("/heartbeat"):
                self.fresh_heartbeat.set()
            if path.endswith("/events"):
                self.fresh_events.set()
        return code, payload


class HeartbeatEpochTests(unittest.TestCase):
    setUp = fixtures.CliProcessTests.setUp
    fake_executable = fixtures.CliProcessTests.fake_executable
    cli = fixtures.CliProcessTests.cli
    credential = fixtures.CliProcessTests.credential
    connect = consent.ConsentLifecycleTests.connect
    queued = consent.ConsentLifecycleTests.queued
    competing_cli = fixtures.CliProcessTests.competing_cli
    completed_cli = fixtures.CliProcessTests.completed_cli

    def old_success_after_new_enrollment(self, same_credential):
        peer = SuccessfulEpochPeer(same_credential)
        self.addCleanup(peer.close)
        sources = json.loads(self.cli("discover").stdout)["sessions"]
        self.connect(peer, sources)
        peer.reject_delivery = True
        self.assertEqual(self.cli("daemon", "start", "--foreground", "--once").returncode, 0)
        retained = next(event for event in self.queued() if event["source_id"] == sources[1]["id"])
        peer.reject_delivery = False
        peer.arm()
        connecting = self.competing_cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                                        "--credential-file", self.credential(peer.origin), "--select", sources[1]["id"],
                                        "--yes", "--no-start")
        self.addCleanup(lambda: self.cli("daemon", "stop"))
        try:
            self.assertTrue(peer.registration_entered.wait(5), "connect is stopped, before rotating the old credential")
            started = self.cli("daemon", "start", "--interval", "3600")
            self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
            self.assertTrue(peer.heartbeat_entered.wait(5), "old credential must receive an actual successful heartbeat")
            peer.registration_release.set()
            self.completed_cli(connecting)
            committed = State(self.state_dir).data
            self.assertEqual(committed["credential"] == peer.old_credential, same_credential)
            self.assertEqual(self.queued(), [retained])
            peer.finished_enrollment = True
            peer.heartbeat_release.set()
            continued = peer.fresh_heartbeat.wait(3)
            if continued:
                self.assertTrue(peer.fresh_events.wait(3))
            self.assertEqual(self.cli("daemon", "stop").returncode, 0)
            saved = State(self.state_dir).data
            for field in ["credential", "selections_revision", "selections", "approved_selections", "observing"]:
                self.assertEqual(saved[field], committed[field], field)
            self.assertTrue(continued, "a stale success must promptly retry with the current epoch, not wait 3600 seconds")
            self.assertEqual(peer.accepted.get(retained["event_id"]), retained, "still-approved pending metadata keeps its exact identity and sequence")
            delivered = [body for _, path, _, body in peer.requests if path.endswith("/events") and body["selections_revision"] == committed["selections_revision"]]
            self.assertTrue(delivered)
            self.assertTrue(all(event["source_id"] == sources[1]["id"] for body in delivered for event in body["events"]))
        finally:
            peer.registration_release.set()
            peer.heartbeat_release.set()

    def test_old_success_cannot_overwrite_new_credential_consent_or_prune_its_pending_event(self):
        self.old_success_after_new_enrollment(False)

    def test_old_success_is_fenced_by_new_consent_even_when_enrollment_keeps_the_same_credential(self):
        self.old_success_after_new_enrollment(True)

    def direct(self):
        state = State(self.state_dir)
        selected = [{"source_id": name, "harness": "claude", "mode": "session", "external_session_id": name,
                     "include_future_sessions": False} for name in ["A", "B"]]
        state.data.update(origin="http://127.0.0.1:1", workspace_id="personal:test", connector_id="connector", credential="fake-test-key",
                          selections_revision=1, selections=selected, approved_selections=selected, observing=True)
        state.save()
        queue = Queue(self.state_dir)
        self.addCleanup(queue.close)
        for name in ["A", "B"]:
            queue.observe(name, SimpleNamespace(id=name, activity="working", harness="claude"))
        return state, queue, selected

    def test_success_snapshot_includes_active_approved_revision_and_observing_fields(self):
        for field in ["selections", "approved_selections", "selections_revision", "observing"]:
            with self.subTest(field=field):
                self.state_dir = self.home / field
                state, queue, selected = self.direct()
                before = queue.batch()
                changed = selected[1:] if field in ["selections", "approved_selections"] else 2 if field == "selections_revision" else False

                def response(*args):
                    writer = State(self.state_dir)
                    writer.data[field] = changed
                    writer.data["unrelated_metadata"] = "newer"
                    writer.save()
                    return {"selections": [], "selections_revision": 1}

                with patch.object(daemon, "request", response), patch.object(daemon, "observe") as observe:
                    result = daemon.tick(state, queue)
                self.assertEqual(result, "connection_changed")
                self.assertEqual(queue.batch(), before)
                self.assertEqual(state.data, State(self.state_dir).data)
                self.assertEqual(state.data["unrelated_metadata"], "newer")
                observe.assert_not_called()

    def test_current_success_still_removes_consent_but_cannot_widen_or_rebind_it(self):
        state, queue, selected = self.direct()
        before = queue.batch()
        widened = {**selected[0], "mode": "harness", "external_session_id": None, "include_future_sessions": True}
        rebound = {**selected[0], "external_session_id": "different"}

        def response(_origin, _token, _method, path, _body):
            if path.endswith("/heartbeat"):
                writer = State(self.state_dir)
                writer.data["unrelated_metadata"] = "retained"
                writer.save()
                return {"selections": [selected[1], widened, rebound], "selections_revision": 2}
            raise OSError("fixture keeps the retained delivery pending")

        with patch.object(daemon, "request", response), patch.object(daemon, "observe", return_value=[]):
            self.assertEqual(daemon.tick(state, queue), "queued")
        self.assertEqual(queue.batch(), [before[1]])
        self.assertEqual(state.data["selections"], selected[1:])
        self.assertEqual(state.data["approved_selections"], selected)
        self.assertEqual(state.data["unrelated_metadata"], "retained")
        self.assertEqual(queue.db.execute("SELECT value FROM counters WHERE name='sequence'").fetchone()[0], 2)
        queue.observe("B", SimpleNamespace(id="B", activity="working", harness="claude"))
        self.assertEqual(queue.batch(), [before[1]], "current pruning preserves retained dedup")

    def lock_is_held(self):
        fd = os.open(self.state_dir / "config.lock", os.O_RDWR)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            return False
        finally:
            os.close(fd)

    def test_heartbeat_pruning_holds_the_config_lock_until_state_publication(self):
        state, queue, selected = self.direct()
        held = []
        retain = queue.retain_sources

        def pruning(sources):
            held.append(self.lock_is_held())
            retain(sources)

        def response(_origin, _token, _method, path, _body):
            if path.endswith("/heartbeat"):
                return {"selections": selected[1:], "selections_revision": 2}
            raise OSError("fixture delivery unavailable")

        with patch.object(queue, "retain_sources", pruning), patch.object(daemon, "request", response), patch.object(daemon, "observe", return_value=[]):
            daemon.tick(state, queue)
        self.assertEqual(held, [True], "enrollment cannot publish between response validation and queue pruning")

    def test_enrollment_pruning_holds_the_same_config_lock_through_completed_publication(self):
        peer = fixtures.Peer()
        self.addCleanup(peer.close)
        sources = json.loads(self.cli("discover").stdout)["sessions"]
        self.connect(peer, sources)
        held = []
        retain = Queue.retain_sources

        def pruning(queue, approved):
            held.append(self.lock_is_held())
            retain(queue, approved)

        args = ["connect", "--state-dir", str(self.state_dir), "--origin", peer.origin, "--workspace-id", "personal:test",
                "--credential-file", self.credential(peer.origin), "--select", sources[1]["id"], "--yes", "--no-start"]
        with patch.dict(os.environ, self.env, clear=True), patch.object(Queue, "retain_sources", pruning):
            self.assertEqual(cli.main(args), 0)
        self.assertEqual(held, [True], "heartbeat settlement cannot enter the enrollment prune/publication gap")
