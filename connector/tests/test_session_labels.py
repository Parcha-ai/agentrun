"""Names come only from native metadata and only leave for capable receivers."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from agentrun_cli.adapters import candidates
from agentrun_cli.queue import Queue
from agentrun_cli.state import State
from agentrun_cli.network import InvalidResponse, response_payload
from agentrun_cli import daemon


class SessionLabels(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name); self.state = State(self.directory)

    def candidate(self, **metadata):
        row = {'id': 'native-session-one', 'cwd': '/private/company/console', 'status': {'type': 'idle'}, **metadata}
        return candidates(self.state, 'codex', [row])[0]

    def test_native_title_and_project_basename_without_preview_or_private_path(self):
        candidate = self.candidate(name='AgentRun OSS -> Hosted conversion', preview='DO NOT EXPORT PRIVATE PROMPT', path='/private/rollout.jsonl')
        queue = Queue(self.directory); self.addCleanup(queue.close)
        queue.observe('source', candidate, collect_labels=True)
        payload = queue.batch()[0]
        self.assertEqual(payload['metadata'], {'harness': 'codex', 'activity': 'idle', 'display_name': 'AgentRun OSS -> Hosted conversion', 'project_name': 'console'})
        self.assertNotIn('/private', json.dumps(payload)); self.assertNotIn('PRIVATE PROMPT', json.dumps(payload))
        self.assertNotIn('display_name', candidate.public(), 'local discovery retains its existing privacy contract')

    def test_delegated_task_basename_and_metadata_nickname_are_readable(self):
        candidate = self.candidate(agentNickname='Ada', source={'subAgent': {'thread_spawn': {'agent_path': '/root/console_review'}}})
        self.assertEqual(candidate.display_name, 'Console review · Ada')
        self.assertEqual(self.candidate(agentNickname='Ada', agentRole='reviewer').display_name, 'Ada · reviewer')
        self.assertNotIn('/root', candidate.display_name)
        unsafe = self.candidate(source={'subAgent': {'thread_spawn': {'agent_path': '/root/sk-private-key'}}})
        self.assertTrue(unsafe.display_name.startswith('Codex · console · '))

    def test_unnamed_sessions_never_fall_back_to_prompt_and_have_stable_distinct_ids(self):
        one = self.candidate(preview='Build a secret app', title=None)
        two = self.candidate(id='native-session-two', preview='Another secret prompt')
        self.assertEqual(one.display_name, 'Codex · console · ' + one.id[-8:])
        self.assertNotEqual(one.display_name, two.display_name)
        self.assertEqual(self.candidate().display_name, one.display_name)

    def test_safe_relative_slashes_work_but_paths_credentials_controls_do_not(self):
        self.assertEqual(self.candidate(name='Fix CI/CD and task-planner').display_name, 'Fix CI/CD and task-planner')
        # Construct synthetic home paths and provider-shaped keys without publishing plausible literals.
        for unsafe in ['/home/' + 'person/private', '//server/share', 'Inspect //server/share', 'Inspect /private/key.txt', 'file:///private/config', 'C:\\private\\config', 'Bearer private-token', 'Bearer\u00a0private-token', 'éSK-private', 'sk-fake-private-key', 'ghp_privatekey', 'AKIA' + '123456789012ABCD', 'hidden\u202evalue', 'line\nname', '\ud800']:
            with self.subTest(label=ascii(unsafe)):
                self.assertTrue(self.candidate(name=unsafe).display_name.startswith('Codex · console · '))
        candidate = self.candidate(cwd='/private/sk-secret-project')
        self.assertIsNone(candidate.project_name); self.assertTrue(candidate.display_name.startswith('Codex · '))
        self.assertNotIn('secret-project', candidate.display_name)

    def test_unicode_labels_are_bounded_in_wire_utf16_units(self):
        candidate = self.candidate(name='🤖' * 100)
        self.assertLessEqual(len(candidate.display_name.encode('utf-16-le')) // 2, 120)
        self.assertNotIn('\ud83e', candidate.display_name)

    def test_unicode_name_batches_fit_receiver_byte_limit_and_all_events_deliver(self):
        queue = Queue(self.directory); self.addCleanup(queue.close)
        candidate = self.candidate(name='修' * 120, cwd='/private/' + '界' * 80)
        for index in range(100):
            queue.observe('s' * 128, candidate.model_copy(update={'id': 'e' * 125 + f'{index:03d}'}), collect_labels=True)
        sequences = []
        while queue.count():
            batch = queue.batch()
            self.assertTrue(batch)
            self.assertLessEqual(len(batch), 50)
            encoded = json.dumps({'selections_revision': (1 << 53) - 1, 'events': batch}).encode()
            self.assertLessEqual(len(encoded), 64 * 1024, 'valid Unicode names must not poison delivery with 413')
            sequences.extend(event['sequence'] for event in batch)
            queue.acknowledge([event['event_id'] for event in batch])
        self.assertEqual(sequences, list(range(1, 101)))

    def test_queue_byte_limit_counts_encoded_unicode_storage(self):
        queue = Queue(self.directory, max_bytes=600); self.addCleanup(queue.close)
        queue.observe('source', self.candidate(name='修' * 120, cwd='/private/' + '界' * 80), collect_labels=True)
        self.assertEqual(queue.count(), 0)
        self.assertEqual(queue.dropped(), 1)

    def test_rename_while_idle_is_emitted_once_and_checkpoint_survives_restart(self):
        queue = Queue(self.directory, refresh_seconds=120); candidate = self.candidate(name='Old title')
        queue.observe('source', candidate, collect_labels=True); first = queue.batch()[0]; queue.acknowledge([first['event_id']])
        candidate = self.candidate(name='New title'); queue.observe('source', candidate, collect_labels=True)
        renamed = queue.batch()[0]; self.assertGreater(renamed['sequence'], first['sequence']); self.assertEqual(renamed['metadata']['display_name'], 'New title')
        queue.acknowledge([renamed['event_id']]); queue.close(); queue = Queue(self.directory, refresh_seconds=120); self.addCleanup(queue.close)
        queue.observe('source', candidate, collect_labels=True); self.assertEqual(queue.batch(), [])

    def test_legacy_capability_omission_sends_no_new_fields(self):
        queue = Queue(self.directory); self.addCleanup(queue.close)
        candidate = self.candidate(name='Native title')
        queue.observe('source', candidate)
        self.assertEqual(queue.batch()[0]['metadata'], {'harness': 'codex', 'activity': 'idle'})
        queue.acknowledge([e['event_id'] for e in queue.batch()]); queue.observe('source', candidate, collect_labels=True)
        self.assertEqual(queue.batch()[0]['metadata']['display_name'], 'Native title')

    def test_unread_selected_session_keeps_labels_but_reports_unknown_activity(self):
        candidate = self.candidate(name='Selected historical task')
        queue = Queue(self.directory, binding='original')
        queue.observe('source', candidate, collect_labels=True)
        queue.acknowledge([event['event_id'] for event in queue.batch()]); queue.close()
        queue = Queue(self.directory, binding='original'); self.addCleanup(queue.close)
        unavailable = candidate.model_copy(update={'native_id': '', 'activity': 'unknown', 'display_name': None,
                                                   'project_name': None, 'usage_path': None})
        queue.observe('source', unavailable, collect_labels=True)
        self.assertEqual(queue.batch()[0]['metadata'], {'harness': 'codex', 'activity': 'unknown',
                         'display_name': 'Selected historical task', 'project_name': 'console'})
        self.assertNotIn('usage', queue.batch()[0], 'a missed read must not replay cached usage')
        queue.acknowledge([event['event_id'] for event in queue.batch()])
        queue.observe('source', unavailable, collect_labels=False)
        self.assertEqual(queue.batch()[0]['metadata'], {'harness': 'codex', 'activity': 'unknown'})

    def test_unread_session_cannot_restore_another_destinations_labels(self):
        candidate = self.candidate(name='Previous destination title')
        queue = Queue(self.directory, binding='original')
        queue.observe('source', candidate, collect_labels=True); queue.close()
        queue = Queue(self.directory, binding='replacement'); self.addCleanup(queue.close)
        unavailable = candidate.model_copy(update={'native_id': '', 'activity': 'unknown', 'display_name': None, 'project_name': None})
        queue.observe('source', unavailable, collect_labels=True)
        self.assertEqual(queue.batch()[0]['metadata'], {'harness': 'codex', 'activity': 'unknown'})

    def test_metadata_has_no_authority_to_expand_selection(self):
        chosen = self.candidate(name='Selected')
        selections = [{'harness':'codex','mode':'session','external_session_id':chosen.id,'source_id':chosen.id,'include_future_sessions':False}]
        selected = candidates(self.state, 'codex', [{'id':'other-session','cwd':'/private/other','name':'Unselected private title'}], selections=selections)
        self.assertEqual(selected, []); self.assertNotIn('codex:other-session', self.state.data['identities'])

    def test_claude_native_title_is_supported_without_using_first_prompt(self):
        candidate = candidates(self.state, 'claude', [{'sessionId': 'claude-session', 'cwd': '/private/console',
                               'title': 'Review console', 'firstPrompt': 'PRIVATE PROMPT', 'status': 'busy'}])[0]
        self.assertEqual(candidate.display_name, 'Review console')
        self.assertEqual(candidate.project_name, 'console')
        self.assertEqual(candidate.activity, 'working')

    def test_failed_rename_is_not_checkpointed_and_old_queue_writes_still_work(self):
        queue = Queue(self.directory); self.addCleanup(queue.close)
        queue.observe('source', self.candidate(name='Old name'), collect_labels=True)
        first = queue.batch()[0]; queue.acknowledge([first['event_id']])
        before = queue.db.execute('SELECT * FROM metadata_labels').fetchall()
        queue.db.execute("CREATE TEMP TRIGGER stop_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture write failed'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            queue.observe('source', self.candidate(name='New name'), collect_labels=True)
        self.assertEqual(queue.db.execute('SELECT * FROM metadata_labels').fetchall(), before)
        queue.db.execute('DROP TRIGGER stop_event')
        queue.observe('source', self.candidate(name='New name'), collect_labels=True)
        self.assertEqual(queue.batch()[0]['sequence'], first['sequence'] + 1)
        # An earlier connector can still use its four-column write after rollback.
        queue.db.execute("INSERT OR REPLACE INTO observations VALUES ('legacy','idle',10,0)")
        queue.db.commit()

    def capabilities(self, **extra):
        return {'version': 1, 'ingestion_modes': ['polling'], 'supported_harnesses': ['codex'],
                'logs_formats': ['json'], 'logs_endpoint_template': '/logs', 'selections_revision_header': 'X-Revision',
                'max_log_records': 100, 'max_payload_bytes': 65536, 'privacy': {}, **extra}

    def test_capabilities_validate_exact_boolean_and_default_to_disabled(self):
        def parse(value):
            return response_payload(json.dumps(value), 'GET', '/connectors/capabilities')
        self.assertFalse(parse(self.capabilities())['session_labels'])
        self.assertTrue(parse(self.capabilities(session_labels=True))['session_labels'])
        for invalid in ['true', 1, None]:
            with self.subTest(value=invalid), self.assertRaises(InvalidResponse):
                parse(self.capabilities(session_labels=invalid))

    def test_daemon_negotiates_labels_and_delivers_to_legacy_or_capable_receivers(self):
        for mode in ['supported', 'missing', 'unavailable']:
            with self.subTest(mode=mode):
                directory = self.directory / mode; state = State(directory)
                candidate = candidates(state, 'codex', [{'id': 'session', 'cwd': '/private/console',
                                      'name': 'Native title', 'status': {'type': 'idle'}}])[0]
                selected = [{'source_id': candidate.id, 'harness': 'codex', 'mode': 'session',
                             'external_session_id': candidate.id, 'include_future_sessions': False}]
                state.data.update(origin='http://127.0.0.1:1', workspace_id='personal:test', connector_id='connector',
                                  credential='test-credential', selections_revision=1, selections=selected,
                                  approved_selections=selected, observing=True)
                state.save()
                queue = Queue(directory); self.addCleanup(queue.close)
                queue.usage_capability_checked_at = 0
                # Failed capability checks must clear a previously cached enabled value.
                queue.session_labels_enabled = True
                delivered = []
                def request(_origin, _token, method, path, body=None):
                    if path.endswith('/capabilities'):
                        if mode == 'unavailable':
                            raise OSError('fixture unavailable')
                        return response_payload(json.dumps(self.capabilities(**({'session_labels': True} if mode == 'supported' else {}))), method, path)
                    if path.endswith('/heartbeat'):
                        return {'selections_revision': 1, 'selections': selected}
                    delivered.extend(body['events'])
                    return {'accepted_event_ids': [event['event_id'] for event in body['events']]}
                with patch.object(daemon, 'request', request), patch.object(daemon, 'observe', return_value=[candidate]):
                    self.assertEqual(daemon.tick(state, queue), 'delivered')
                self.assertEqual(len(delivered), 1)
                self.assertEqual('display_name' in delivered[0]['metadata'], mode == 'supported')
                self.assertEqual(queue.count(), 0, 'older receivers must not be given unsupported metadata')
