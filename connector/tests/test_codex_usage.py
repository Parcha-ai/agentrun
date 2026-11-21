"""Existing native sessions report only new, metadata-only usage after enrollment."""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agentrun_cli import daemon
from agentrun_cli.adapters import candidates
from agentrun_cli.queue import Queue
from agentrun_cli.codex_usage import read_usage, MAX_READ_BYTES
from agentrun_cli.state import State


def tokens(i, o, cached=0, timestamp='2026-11-17T12:00:00Z'):
    return {'type': 'event_msg', 'timestamp': timestamp, 'payload': {'type': 'token_count', 'info': {'total_token_usage': {'input_tokens': i, 'output_tokens': o, 'cached_input_tokens': cached, 'cache_write_input_tokens': 0}}}}


class ExistingCodexUsage(unittest.TestCase):
    def setUp(self):
        clock = patch('agentrun_cli.codex_usage.time.time', return_value=1795132800); clock.start(); self.addCleanup(clock.stop)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.sessions = self.root / 'sessions'; self.sessions.mkdir()
        self.patch = patch.dict(os.environ, {'CODEX_HOME': str(self.root)}); self.patch.start(); self.addCleanup(self.patch.stop)
        self.path = self.sessions / 'rollout.jsonl'
        self.append({'type': 'session_meta', 'payload': {'id': 'native-one'}})
        self.append({'type': 'turn_context', 'payload': {'model': 'gpt-test'}})
        self.candidate = SimpleNamespace(id='opaque-one', native_id='native-one', harness='codex', activity='working', usage_path=str(self.path), model='gpt-test')

    def append(self, value):
        with self.path.open('a') as file: file.write(json.dumps(value) + '\n')

    def read(self, previous=None):
        return read_usage(self.candidate, previous)

    def test_baselines_existing_lifetime_usage_then_emits_new_deltas_at_source_time(self):
        self.append(tokens(1000000, 10000, 800000))
        state, events = self.read(); self.assertEqual(events, [])
        self.append({'type': 'response_item', 'payload': {'secret': 'private prompt must not escape'}})
        self.append(tokens(1000100, 10020, 800060, '2026-11-18T00:00:01Z'))
        state, events = self.read(state)
        self.assertEqual(events, [{'occurred_at': '2026-11-18T00:00:01Z', 'usage': {'model': 'gpt-test', 'input_tokens': 100, 'output_tokens': 20, 'cache_read_tokens': 60, 'cache_write_tokens': 0}}])
        self.assertNotIn('private prompt', json.dumps(state)); self.assertEqual(self.read(state)[1], [])

    def test_model_changes_duplicates_counter_resets_and_missing_cache(self):
        self.append(tokens(100, 10, 60)); state, _ = self.read()
        self.append(tokens(100, 10, 60)); self.append({'type': 'turn_context', 'payload': {'model': 'gpt-next'}})
        self.append(tokens(120, 15, 70)); self.append(tokens(5, 1, 1)); self.append(tokens(15, 3, 4))
        state, events = self.read(state)
        self.assertEqual([(e['usage']['model'], e['usage']['input_tokens']) for e in events], [('gpt-next', 20), ('gpt-next', 10)])
        record = tokens(20, 4); del record['payload']['info']['total_token_usage']['cached_input_tokens']
        self.append(record); state, events = self.read(state)
        self.assertNotIn('cache_read_tokens', events[0]['usage'])

    def test_partial_lines_are_not_lost_and_large_gaps_rebaseline(self):
        self.append(tokens(100, 10)); state, _ = self.read()
        payload = json.dumps(tokens(130, 15))
        with self.path.open('a') as file: file.write(payload[:30])
        state, events = self.read(state); self.assertEqual(events, [])
        with self.path.open('a') as file: file.write(payload[30:] + '\n')
        state, events = self.read(state); self.assertEqual(events[0]['usage']['input_tokens'], 30)
        with self.path.open('a') as file: file.write('x' * (MAX_READ_BYTES + 1) + '\n')
        self.append(tokens(900000, 9000)); state, events = self.read(state); self.assertEqual(events, [])
        self.append(tokens(900010, 9001)); self.assertEqual(self.read(state)[1][0]['usage']['input_tokens'], 10)

    def test_native_identity_and_safe_path_are_required(self):
        self.append(tokens(100, 10)); self.candidate.native_id = 'another-session'
        self.assertEqual(self.read(), (None, []))
        self.candidate.native_id = 'native-one'; self.candidate.usage_path = str(self.root / 'outside.jsonl')
        Path(self.candidate.usage_path).write_text(self.path.read_text())
        self.assertEqual(self.read(), (None, []))
        link = self.sessions / 'link.jsonl'; link.symlink_to(self.path); self.candidate.usage_path = str(link)
        self.assertEqual(self.read(), (None, []))

    def test_new_session_first_call_is_counted_and_future_reports_cannot_poison_delivery(self):
        state, _ = self.read(); self.append(tokens(20, 3))
        state, events = self.read(state); self.assertEqual(events[0]['usage']['input_tokens'], 20)
        self.append(tokens(40, 5, timestamp='2099-01-01T00:00:00Z')); state, events = self.read(state); self.assertEqual(events, [])
        self.append(tokens(30, 4, timestamp='2026-11-17 13:00:00+00:00'))
        state, events = self.read(state); self.assertEqual(events[0]['occurred_at'], '2026-11-17T13:00:00Z')
        self.assertEqual(events[0]['usage']['input_tokens'], 10)

    def test_out_of_order_timestamps_do_not_rewind_baseline(self):
        self.append(tokens(100, 10)); state, _ = self.read()
        self.append(tokens(80, 8, timestamp='2026-11-17T11:00:00Z')); self.append(tokens(100, 10))
        state, events = self.read(state); self.assertEqual(events, [])
        self.append(tokens(110, 11)); self.assertEqual(self.read(state)[1][0]['usage']['input_tokens'], 10)

    def test_corrupt_metadata_and_unaccepted_models_cannot_poison_observer(self):
        self.path.write_text('[]\n'); self.assertEqual(self.read(), (None, []))
        self.path.write_text(''); self.append({'type': 'session_meta', 'payload': {'id': 'native-one'}})
        self.candidate.model = 'provider/model@revision'; self.append(tokens(100, 10)); state, _ = self.read()
        self.append(tokens(120, 11)); self.assertEqual(self.read(state)[1], [])

    def test_counter_reset_cannot_coalesce_to_unsafe_wire_integer(self):
        self.append(tokens(0, 0)); q = Queue(self.root); self.addCleanup(q.close)
        q.observe('source', self.candidate, collect_usage=True); q.acknowledge([e['event_id'] for e in q.batch()])
        self.append(tokens((1 << 53) - 1, 0)); self.append(tokens(0, 0)); self.append(tokens(1, 0))
        q.observe('source', self.candidate, collect_usage=True)
        self.assertFalse(any('usage' in e for e in q.batch())); self.assertEqual(q.dropped(), 1)

    def test_queue_commits_usage_checkpoint_and_event_atomically_and_survives_restart(self):
        self.append(tokens(100, 10)); q = Queue(self.root, refresh_seconds=3600, binding='A')
        q.observe('source', self.candidate, collect_usage=True); q.acknowledge([e['event_id'] for e in q.batch()])
        self.append(tokens(150, 20, 10)); q.db.execute("CREATE TEMP TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.IntegrityError): q.observe('source', self.candidate, collect_usage=True)
        q.db.execute('DROP TRIGGER reject_event'); q.close(); q = Queue(self.root, refresh_seconds=3600, binding='A'); self.addCleanup(q.close)
        q.observe('source', self.candidate, collect_usage=True)
        usage = [e for e in q.batch() if 'usage' in e]; self.assertEqual(len(usage), 1); self.assertEqual(usage[0]['usage']['input_tokens'], 50)
        self.assertNotIn('private', json.dumps(q.batch()))
        last = q.batch()[-1]; self.assertNotIn('usage', last, 'fresh activity follows source-dated usage')
        q.acknowledge([e['event_id'] for e in q.batch()]); q.observe('source', self.candidate, collect_usage=True); self.assertEqual(q.batch(), [])
        q.retain_sources(set()); self.append(tokens(160, 21, 10)); q.observe('source', self.candidate, collect_usage=True)
        self.assertFalse(any('usage' in e for e in q.batch()), 'renewed consent starts a fresh baseline')

    def daemon_fixture(self, *, enabled=True, selected=True):
        state = State(self.root / 'observer')
        row = {'id': 'native-one', 'cwd': str(self.root), 'path': str(self.path),
               'model': 'gpt-test', 'status': {'type': 'active'}}
        candidate = candidates(state, 'codex', [row])[0]
        selections = [{'source_id': candidate.id, 'harness': 'codex', 'mode': 'session',
                       'external_session_id': candidate.id, 'include_future_sessions': False}] if selected else []
        state.data.update(origin='http://127.0.0.1:1', workspace_id='personal:test', connector_id='connector',
                          credential='test-credential', selections_revision=1, selections=selections,
                          approved_selections=selections, observing=True)
        state.save()
        delivered = []

        def request(_origin, _token, _method, path, body=None):
            if path.endswith('/capabilities'):
                return {'token_usage': {'polling': enabled}}
            if path.endswith('/heartbeat'):
                return {'selections_revision': 1, 'selections': selections}
            delivered.extend(body['events'])
            return {'accepted_event_ids': [event['event_id'] for event in body['events']]}

        def poll(queue):
            observed = candidates(state, 'codex', [row])
            with patch.object(daemon, 'request', request), patch.object(daemon, 'observe', return_value=observed):
                self.assertEqual(daemon.tick(state, queue), 'delivered')
            return observed[0]

        def queue():
            result = Queue(state.directory)
            result.usage_capability_checked_at = 0
            self.addCleanup(result.close)
            return result

        return row, delivered, poll, queue

    def test_daemon_collects_final_failed_session_counters_once_across_polls_and_restart(self):
        row, delivered, poll, queue = self.daemon_fixture()
        self.append(tokens(100, 10, 60))
        current = queue()
        self.assertEqual(poll(current).activity, 'working')
        self.assertFalse(any('usage' in event for event in delivered), 'existing totals only establish the baseline')
        self.append(tokens(160, 17, 100, '2026-11-18T00:00:01Z'))
        row['status'] = {'type': 'systemError'}
        self.assertEqual(poll(current).activity, 'failed', 'exercise the native terminal status mapping')
        expected = [{'model': 'gpt-test', 'input_tokens': 60, 'output_tokens': 7,
                     'cache_read_tokens': 40, 'cache_write_tokens': 0}]
        self.assertEqual([event['usage'] for event in delivered if 'usage' in event], expected)
        final = next(event for event in delivered if 'usage' in event)
        self.assertEqual(final['occurred_at'], '2026-11-18T00:00:01Z')
        self.assertEqual(final['metadata']['activity'], 'failed')
        poll(current)
        current.close()
        current = queue()
        poll(current)
        self.assertEqual([event['usage'] for event in delivered if 'usage' in event], expected,
                         'a retained failed session never repeats acknowledged usage, including after restart')
        self.append(tokens(165, 18, 101, '2026-11-18T00:00:02Z'))
        poll(current)
        self.assertEqual([event['usage'] for event in delivered if 'usage' in event], expected + [
            {'model': 'gpt-test', 'input_tokens': 5, 'output_tokens': 1, 'cache_read_tokens': 1, 'cache_write_tokens': 0}],
            'a later native flush after failure is still collected')

    def test_failed_session_usage_still_requires_receiver_capability(self):
        row, delivered, poll, queue = self.daemon_fixture(enabled=False)
        row['status'] = {'type': 'systemError'}
        with patch('agentrun_cli.queue.read_usage', wraps=read_usage) as read:
            poll(queue())
        read.assert_not_called()
        self.assertEqual([event['metadata']['activity'] for event in delivered], ['failed'])
        self.assertFalse(any('usage' in event for event in delivered))

    def test_failed_session_usage_still_requires_current_source_consent(self):
        row, delivered, poll, queue = self.daemon_fixture(selected=False)
        row['status'] = {'type': 'systemError'}
        with patch('agentrun_cli.queue.read_usage', wraps=read_usage) as read:
            poll(queue())
        read.assert_not_called()
        self.assertEqual(delivered, [])
