"""Consent transitions and local limits cannot widen delivery or child credentials."""

import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agentrun_cli import adapters, cli
from agentrun_cli.queue import Queue
from agentrun_cli.state import State
import test_cli_process as fixtures


class ConsentLifecycleTests(unittest.TestCase):
    setUp = fixtures.CliProcessTests.setUp
    fake_executable = fixtures.CliProcessTests.fake_executable
    cli = fixtures.CliProcessTests.cli
    peer = fixtures.CliProcessTests.peer
    credential = fixtures.CliProcessTests.credential
    enroll = fixtures.CliProcessTests.enroll
    codex_listing = fixtures.CliProcessTests.codex_listing

    def connect(self, peer, selected=(), **flags):
        args = ["connect", "--origin", peer.origin, "--workspace-id", "personal:test",
                "--credential-file", self.credential(peer.origin), "--yes", "--no-start"]
        for source in selected:
            args.extend(["--select", source["id"]])
        for name, value in flags.items():
            args.extend(["--" + name.replace("_", "-"), value])
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def queued(self):
        with sqlite3.connect(self.state_dir / "queue.sqlite3") as db:
            return [json.loads(row[0]) for row in db.execute("SELECT payload FROM events ORDER BY rowid")]

    def fill(self, collection):
        state = State(self.state_dir)
        mapping = state.data[collection]
        for index in range(4096 - len(mapping)):
            mapping["claude:unrelated-" + str(index)] = "unrelated-opaque-" + str(index)
        state._save()
        return dict(mapping)

    def test_reselecting_before_heartbeat_discards_removed_payload_and_keeps_retained_source(self):
        peer = self.peer()
        sources = json.loads(self.cli("discover").stdout)["sessions"]
        self.connect(peer, sources)
        peer.reject_delivery = True
        self.assertEqual(self.cli("daemon", "start", "--foreground", "--once").returncode, 0)
        old = self.queued()
        self.assertEqual(len(old), 2)
        removed = next(event for event in old if event["source_id"] == sources[0]["id"])
        retained = next(event for event in old if event["source_id"] == sources[1]["id"])
        self.connect(peer, sources[1:])
        after_removal = self.queued()
        self.connect(peer, sources)
        after_return = self.queued()
        peer.reject_delivery = False
        peer.requests.clear()
        delivered = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(delivered.returncode, 0, delivered.stdout + delivered.stderr)
        sent = [request[3] for request in peer.requests if request[1].endswith("/events")]
        self.assertEqual(after_removal, [retained])
        self.assertEqual(after_return, [retained])
        self.assertNotIn(removed["event_id"], peer.accepted)
        self.assertIn(retained["event_id"], peer.accepted)
        fresh = [event for event in peer.accepted.values() if event["source_id"] == sources[0]["id"]]
        self.assertEqual(len(fresh), 1, "unchanged activity is observed immediately after its removed payload was purged")
        self.assertGreater(fresh[0]["sequence"], max(event["sequence"] for event in old))
        self.assertTrue(all(body["selections_revision"] == peer.connector["selections_revision"] for body in sent))

    def test_same_source_id_with_changed_selection_identity_does_not_retain_old_payload(self):
        peer = self.peer()
        source = self.enroll(peer)
        peer.reject_delivery = True
        self.assertEqual(self.cli("daemon", "start", "--foreground", "--once").returncode, 0)
        old = self.queued()[0]
        state = State(self.state_dir)
        # A persisted subscription may reuse an opaque source id; equality of that id alone is not consent.
        state.data["subscriptions"] = {"claude": source["id"]}
        state._save()
        self.connect(peer, subscribe_harness="claude")
        self.assertEqual(self.queued(), [])
        peer.reject_delivery = False
        delivered = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(delivered.returncode, 0, delivered.stdout + delivered.stderr)
        self.assertNotIn(old["event_id"], peer.accepted)
        self.assertTrue(all(event["sequence"] > old["sequence"] for event in peer.accepted.values()))

    def test_queue_is_pruned_before_new_consent_is_published(self):
        peer = self.peer()
        sources = json.loads(self.cli("discover").stdout)["sessions"]
        self.connect(peer, sources)
        peer.reject_delivery = True
        self.assertEqual(self.cli("daemon", "start", "--foreground", "--once").returncode, 0)
        old = self.queued()
        captured = []

        save = State._save

        def interrupted_publish(state, value=None):
            proposed = state.data if value is None else value
            if proposed.get("approved_selections") == [peer.registration_body["selections"][1]] and "pending_registration" not in proposed:
                captured.extend(self.queued())
                raise OSError("fixture refused config publication")
            return save(state, value)

        args = ["connect", "--state-dir", str(self.state_dir), "--origin", peer.origin,
                "--workspace-id", "personal:test", "--credential-file", self.credential(peer.origin),
                "--select", sources[1]["id"], "--yes", "--no-start"]
        with patch.dict(os.environ, self.env, clear=True), patch.object(State, "_save", interrupted_publish):
            self.assertEqual(cli.main(args), 1)
        self.assertEqual(captured, [event for event in old if event["source_id"] == sources[1]["id"]])
        self.assertEqual(State(self.state_dir).data["approved_selections"], peer.registration_body["selections"])

    def test_unrelated_claude_rows_do_not_allocate_observation_identities_or_projects(self):
        peer = self.peer()
        selected = self.enroll(peer, "--refresh-seconds", "0")
        before = State(self.state_dir).data
        row = json.loads(self.sessions.read_text())[0]
        self.sessions.write_text(json.dumps([{"sessionId": "unapproved-new", "cwd": "/private/new", "status": "busy"}, row]))
        result = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        after = State(self.state_dir).data
        self.assertEqual(after["identities"], before["identities"])
        self.assertEqual(after["projects"], before["projects"])
        self.assertEqual({event["external_session_id"] for event in peer.accepted.values()}, {selected["id"]})

    def test_full_identity_map_does_not_stop_existing_selected_session_on_restart(self):
        peer = self.peer()
        selected = self.enroll(peer, "--refresh-seconds", "0")
        before = self.fill("identities")
        projects = self.fill("projects")
        row = json.loads(self.sessions.read_text())[0]
        self.sessions.write_text(json.dumps([{"sessionId": "unseen-at-capacity", "cwd": "/private/new", "status": "busy"}, row]))
        for _ in range(2):
            result = self.cli("daemon", "start", "--foreground", "--once")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(State(self.state_dir).data["identities"], before)
        self.assertEqual(State(self.state_dir).data["projects"], projects)
        self.assertEqual(len(peer.accepted), 2)
        self.assertEqual({event["external_session_id"] for event in peer.accepted.values()}, {selected["id"]})

    def test_full_project_map_does_not_suppress_a_selected_session_that_moves_directory(self):
        peer = self.peer()
        selected = self.enroll(peer)
        before = self.fill("projects")
        row = json.loads(self.sessions.read_text())[0]
        row["cwd"] = "/private/new-selected-directory"
        self.sessions.write_text(json.dumps([row]))
        result = self.cli("daemon", "start", "--foreground", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(State(self.state_dir).data["projects"], before)
        self.assertEqual({event["external_session_id"] for event in peer.accepted.values()}, {selected["id"]})

    def test_explicit_future_subscriptions_at_capacity_preserve_existing_sessions_and_report_partial(self):
        for mode in ["project", "harness"]:
            with self.subTest(mode=mode):
                self.state_dir = self.home / mode
                peer = self.peer()
                sources = json.loads(self.cli("discover").stdout)["sessions"]
                flag, value = ("subscribe_project", sources[0]["project_id"]) if mode == "project" else ("subscribe_harness", "claude")
                self.connect(peer, **{flag: value})
                before = self.fill("identities")
                original = json.loads(self.sessions.read_text())
                try:
                    self.sessions.write_text(json.dumps([{"sessionId": "future-at-capacity", "cwd": "/private/client-a", "status": "busy"}, *original]))
                    result = self.cli("daemon", "start", "--foreground", "--once")
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    after = State(self.state_dir).data
                    self.assertEqual(after["identities"], before)
                    self.assertEqual(len(peer.accepted), 1 if mode == "project" else 2)
                    self.assertTrue(any(row.get("reason") == "candidate_limit" for row in after["discovery_diagnostics"]))
                finally:
                    self.sessions.write_text(json.dumps(original))

    def test_discovery_at_capacity_keeps_known_rows_and_never_invents_a_project_choice(self):
        known = json.loads(self.cli("discover").stdout)["sessions"][0]
        before = self.fill("identities")
        row = json.loads(self.sessions.read_text())[0]
        self.sessions.write_text(json.dumps([{"sessionId": "unseen-at-capacity", "cwd": "/private/new", "status": "busy"}, row]))
        result = self.cli("discover")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["sessions"], [known])
        self.assertTrue(any(item.get("reason") == "candidate_limit" for item in value["adapters"]))
        self.assertEqual(State(self.state_dir).data["identities"], before)

    def test_named_enrollment_secret_is_absent_from_connect_and_detached_daemon_harnesses(self):
        peer = self.peer()
        self.codex_listing()
        probe = self.home / "child-environment.jsonl"
        name = "FIXTURE_ENROLLMENT_ONLY"
        broad = "fixture-enrollment-only-not-a-real-key"
        self.env.update({name: broad, "ANTHROPIC_API_KEY": "fake-test-key", "OPENAI_API_KEY": "test-key",
                         "CLAUDE_CONFIG_DIR": str(self.home / "claude-source"), "CODEX_HOME": str(self.home / "codex-source")})
        for harness in ["claude", "codex"]:
            original = (self.bin / harness).read_text().split("\n", 1)[1]
            code = ("import os,json,pathlib\n" +
                    f"with pathlib.Path({str(probe)!r}).open('a') as out: out.write(json.dumps({{'harness':{harness!r},'enrollment_present':{name!r} in os.environ,'source_auth':os.environ.get('ANTHROPIC_API_KEY')=='fake-test-key','other_auth':os.environ.get('OPENAI_API_KEY')=='test-key','claude_config':os.environ.get('CLAUDE_CONFIG_DIR')=={self.env['CLAUDE_CONFIG_DIR']!r},'codex_config':os.environ.get('CODEX_HOME')=={self.env['CODEX_HOME']!r},'path':os.environ.get('PATH','').startswith({str(self.bin)!r})}})+'\\n')\n" + original)
            self.fake_executable(harness, code)
        self.addCleanup(lambda: self.cli("daemon", "stop"))
        result = self.cli("connect", "--origin", peer.origin, "--workspace-id", "personal:test", "--credential-env", name,
                          "--subscribe-harness", "claude", "--subscribe-harness", "codex", "--yes", "--interval", "1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        deadline = time.monotonic() + 10
        while not any(path.endswith("/events") for _, path, _, _ in peer.requests):
            self.assertLess(time.monotonic(), deadline, "The detached observer did not deliver its first pass")
            time.sleep(.02)
        self.assertEqual(self.cli("daemon", "stop").returncode, 0)
        children = [json.loads(line) for line in probe.read_text().splitlines()]
        for harness in ["claude", "codex"]:
            self.assertGreaterEqual(sum(row["harness"] == harness for row in children), 2, "connect and detached poll both probe the harness")
        self.assertFalse(any(row["enrollment_present"] for row in children))
        self.assertTrue(all(all(row[key] for key in ["source_auth", "other_auth", "claude_config", "codex_config", "path"]) for row in children))
        self.assertTrue(all(auth == "Bearer " + broad for _, path, auth, _ in peer.requests if path.endswith(("/identity", "/connectors"))))
        self.assertTrue(all(auth == "Bearer narrow-connector-test" for _, path, auth, _ in peer.requests if path.endswith(("/heartbeat", "/events"))))
        self.assertNotIn(broad, result.stdout + result.stderr + (self.state_dir / "config.json").read_text())

    def test_named_enrollment_secret_is_removed_before_other_child_spawning_commands(self):
        probe = self.home / "other-child-environment.jsonl"
        name = "FIXTURE_ENROLLMENT_ONLY"
        self.env.update({name: "fixture-only-enrollment", "ANTHROPIC_API_KEY": "fake-test-key"})
        for child in ["claude", "codex", "systemctl"]:
            code = ("import os,json,pathlib,sys\n" +
                    f"with pathlib.Path({str(probe)!r}).open('a') as out: out.write(json.dumps({{'child':{child!r},'enrollment_present':{name!r} in os.environ,'source_auth':os.environ.get('ANTHROPIC_API_KEY')=='fake-test-key'}})+'\\n')\n")
            if child == "claude":
                code += "print('2.1.322' if '--version' in sys.argv else pathlib.Path(os.environ['HARNESS_ROWS']).read_text())\n"
            elif child == "codex":
                code += "print('0.164.0')\n"
            self.fake_executable(child, code)

        checked_children = []

        def checked(*args):
            probe.unlink(missing_ok=True)
            result = self.cli(*args, "--credential-env", name)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            children = [json.loads(line) for line in probe.read_text().splitlines()]
            self.assertTrue(children)
            self.assertTrue(all(row["source_auth"] for row in children))
            checked_children.extend({"command": args[0], **row} for row in children)

        # The parser permits the flag on non-enrollment commands too; it must not be silently inherited.
        checked("discover")
        checked("setup", "--target", "existing-sessions")
        peer = self.peer()
        self.enroll(peer)
        checked("startup", "enable")
        checked("disconnect", "--origin", peer.origin)
        self.assertFalse(State(self.state_dir).data["observing"])
        self.assertFalse(any(row["enrollment_present"] for row in checked_children), checked_children)
        self.assertEqual(self.env[name], "fixture-only-enrollment", "a CLI child cannot mutate its caller's environment")


class QueueConsentTests(unittest.TestCase):
    def test_pruning_keeps_retained_dedup_and_global_checkpoint_but_refreshes_removed_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            q = Queue(Path(temporary), binding="same-destination")
            self.addCleanup(q.close)
            first = SimpleNamespace(id="first", activity="working", harness="claude")
            second = SimpleNamespace(id="second", activity="idle", harness="claude")
            q.observe("A", first)
            q.observe("B", second)
            old = q.batch()
            q.retain_sources({"B"})
            self.assertEqual(q.batch(), [old[1]])
            self.assertEqual(q.db.execute("SELECT value FROM counters WHERE name='sequence'").fetchone()[0], 2)
            q.observe("B", second)
            self.assertEqual(q.batch(), [old[1]], "retained consent preserves its dedup state")
            q.observe("A", first)
            self.assertEqual(len(q.batch()), 2, "removed consent cannot suppress its first fresh observation")
            self.assertEqual(q.batch()[1]["sequence"], 3)

    def test_observation_filter_does_not_hide_unsafe_state_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = State(temporary)
            identity = state.identity("claude", "known")
            state.data["selections"] = [{"source_id": identity, "harness": "claude", "mode": "session",
                                          "external_session_id": identity, "include_future_sessions": False}]
            state.save()
            state.path.chmod(0o644)
            with patch.object(adapters, "command_json", return_value=[{"sessionId": "known", "cwd": "/project"}]), self.assertRaisesRegex(ValueError, "unsafe_state"):
                adapters.observe(state)
