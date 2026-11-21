"""Opaque IDs, consent epochs and shutdown have process-wide boundaries."""
import json
import multiprocessing
from pathlib import Path
import shlex
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agentrun_cli import adapters, cli, telemetry, network
from agentrun_cli.state import State


def allocate(directory, barrier, results):
    state = State(directory)
    barrier.wait()
    identity = state.identity('codex', 'same-native-session')
    project = state.project('codex', '/fixture/project')
    state.save()
    results.put((state.data['installation_id'], identity, project))


class StateBoundaries(unittest.TestCase):
    def test_concurrent_discoveries_return_the_same_persisted_opaque_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = multiprocessing.get_context('fork')
            barrier, results = ctx.Barrier(2), ctx.Queue()
            processes = [ctx.Process(target=allocate, args=(directory, barrier, results)) for _ in range(2)]
            for process in processes:
                process.start()
            try:
                values = [results.get(timeout=5) for _ in processes]
                self.assertEqual(values[0], values[1], 'a returned selection ID must already be canonical across processes')
                saved = State(directory).data
                self.assertEqual(values[0], (saved['installation_id'], saved['identities']['codex:same-native-session'], saved['projects']['codex:/fixture/project']))
            finally:
                for process in processes:
                    process.join(timeout=5)
                    if process.is_alive():
                        process.kill(); process.join()
                results.close(); results.join_thread()

    def test_stale_discovery_save_preserves_other_sessions_and_newer_disconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            one = State(directory); one.save()
            two = State(directory)
            first = one.identity('codex', 'first')
            one.data['observing'] = False; one.save()
            second = two.identity('codex', 'second')
            two.data['discovery_diagnostics'] = []; two.save()
            saved = State(directory).data
            self.assertEqual(saved['identities'], {'codex:first': first, 'codex:second': second})
            self.assertFalse(saved['observing'])

    def test_collector_queue_is_bound_to_destination_credential_and_selection_epoch(self):
        with tempfile.TemporaryDirectory() as directory:
            state = State(directory)
            state.data.update(origin='https://first.example', workspace_id='first', connector_id='same-connector',
                              installation_id='fixture-installation', credential='first-credential', selections_revision=1,
                              selections=[{'source_id': 'fixture-source', 'harness': 'codex'}])
            def queue_path():
                bundle = telemetry.configure(state)
                environment = dict(line.split('=', 1) for line in Path(bundle['credential_env_file']).read_text().splitlines())
                return Path(shlex.split(environment['AGENTRUN_OTEL_QUEUE_DIRECTORY'])[0])
            original = queue_path(); (original / 'queued-record').write_text('metadata approved only for first destination')
            for changes in [dict(origin='https://second.example', workspace_id='second'), dict(credential='rotated-credential'), dict(selections_revision=2)]:
                with self.subTest(changes=changes):
                    state.data.update(changes)
                    fresh = queue_path()
                    self.assertNotEqual(fresh, original)
                    self.assertFalse((fresh / 'queued-record').exists())
                    original = fresh
                    (original / 'queued-record').write_text('prior epoch')

    def test_codex_selected_reads_share_one_total_budget(self):
        now = [0.0]
        class Socket:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def send(self, message): self.message = json.loads(message)
            def recv(self, timeout):
                now[0] += min(4, timeout)
                if timeout < 4: raise TimeoutError()
                return json.dumps({'id': self.message['id'], 'result': {'thread': {'id': str(now[0])}}})
        diagnostic = {}
        with patch.object(adapters, 'command_json', return_value={'status': 'running', 'socketPath': '/fixture/codex.sock'}), \
             patch.object(adapters.Path, 'is_socket', return_value=True), patch.object(adapters, 'unix_connect', return_value=Socket()), \
             patch.object(adapters.time, 'monotonic', side_effect=lambda: now[0]):
            rows = adapters.codex_rows([str(i) for i in range(100)], diagnostic)
        self.assertLessEqual(now[0], 15, 'successful slow reads must not multiply the daemon stop deadline')
        self.assertLessEqual(len(rows), 2)
        self.assertEqual(diagnostic['reason'], 'time_budget')

    def test_codex_stops_between_selected_reads(self):
        calls, completed = [], []
        class Socket:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def send(self, message):
                self.message = json.loads(message)
                if 'id' in self.message: calls.append(self.message['method'])
            def recv(self, timeout):
                completed.append(self.message['method'])
                return json.dumps({'id': self.message['id'], 'result': {'thread': {'id': 'first'}}})
        diagnostic = {}
        with patch.object(adapters, 'command_json', return_value={'status': 'running', 'socketPath': '/fixture/codex.sock'}), \
             patch.object(adapters.Path, 'is_socket', return_value=True), patch.object(adapters, 'unix_connect', return_value=Socket()):
            rows = adapters.codex_rows(['first', 'second'], diagnostic, stopping=lambda: completed.count('thread/read') == 1)
        self.assertEqual(len(rows), 1); self.assertEqual(diagnostic['reason'], 'stopped')
        self.assertEqual(calls.count('thread/read'), 1)

    def test_codex_lists_loaded_subagents_before_bounded_all_source_history(self):
        calls = []
        class Socket:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def send(self, message):
                self.message = json.loads(message)
                if 'id' in self.message: calls.append(self.message)
            def recv(self, timeout):
                method = self.message['method']
                result = ({'data': ['active-child']} if method == 'thread/loaded/list' else
                          {'thread': {'id': 'active-child', 'status': {'type': 'active'}}} if method == 'thread/read' else
                          {'data': [{'id': 'history'}, {'id': 'active-child'}], 'nextCursor': None} if method == 'thread/list' else {})
                return json.dumps({'id': self.message['id'], 'result': result})
        with patch.object(adapters, 'command_json', return_value={'status': 'running', 'socketPath': '/fixture/codex.sock'}), patch.object(adapters.Path, 'is_socket', return_value=True), patch.object(adapters, 'unix_connect', return_value=Socket()):
            rows = adapters.codex_rows()
        self.assertEqual([row['id'] for row in rows], ['active-child', 'history'])
        requested = next(call['params']['sourceKinds'] for call in calls if call['method'] == 'thread/list')
        self.assertTrue({'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentThreadSpawn', 'unknown'} <= set(requested))

    def test_mixed_codex_selections_keep_explicit_history_and_filter_loaded_sessions(self):
        for mode in ('project', 'harness'):
            for loaded_available in (True, False):
                with self.subTest(mode=mode, loaded_available=loaded_available), tempfile.TemporaryDirectory() as directory:
                    state = State(directory)
                    historical = state.identity('codex', 'historical')
                    live = state.identity('codex', 'live')
                    project = state.project('codex', '/fixture/subscribed')
                    state.data['selections'] = [
                        {'source_id': identity, 'harness': 'codex', 'mode': 'session',
                         'external_session_id': identity, 'include_future_sessions': False}
                        for identity in (historical, live)
                    ] + [{'source_id': project if mode == 'project' else 'codex', 'harness': 'codex', 'mode': mode,
                          'external_session_id': '', 'include_future_sessions': True}]
                    raw = {
                        'historical': {'id': 'historical', 'cwd': '/fixture/history', 'name': 'Historical task',
                                       'path': '/fixture/history/rollout.jsonl', 'model': 'codex-model', 'status': {'type': 'idle'}},
                        'live': {'id': 'live', 'cwd': '/fixture/subscribed', 'name': 'Current task',
                                 'status': {'type': 'active', 'activeFlags': ['waitingOnApproval']}},
                        'outside': {'id': 'outside', 'cwd': '/fixture/other', 'name': 'Another task', 'status': {'type': 'active'}},
                    }
                    calls = []
                    class Socket:
                        def __enter__(self): return self
                        def __exit__(self, *args): pass
                        def send(self, message):
                            self.message = json.loads(message)
                            if 'id' in self.message: calls.append(self.message)
                        def recv(self, timeout):
                            method = self.message['method']
                            if method == 'thread/loaded/list' and not loaded_available:
                                return json.dumps({'id': self.message['id'], 'error': {'code': -32601}})
                            result = ({'data': ['live', 'outside']} if method == 'thread/loaded/list' else
                                      {'thread': raw[self.message['params']['threadId']]} if method == 'thread/read' else
                                      {'data': [raw['live'], raw['outside']], 'nextCursor': None} if method == 'thread/list' else {})
                            return json.dumps({'id': self.message['id'], 'result': result})
                    with patch.object(adapters, 'command_json', return_value={'status': 'running', 'socketPath': '/fixture/codex.sock'}), \
                         patch.object(adapters.Path, 'is_socket', return_value=True), patch.object(adapters, 'unix_connect', return_value=Socket()):
                        observed = adapters.observe(state)
                    by_native = {row.native_id: row for row in observed}
                    self.assertIn('historical', by_native, 'an unloaded explicit session must be read, not replaced by an unknown placeholder')
                    self.assertEqual((by_native['historical'].id, by_native['historical'].display_name, by_native['historical'].activity),
                                     (historical, 'Historical task', 'idle'))
                    self.assertEqual(by_native['historical'].usage_path, '/fixture/history/rollout.jsonl')
                    self.assertEqual(by_native['historical'].model, 'codex-model')
                    self.assertEqual((by_native['live'].display_name, by_native['live'].activity), ('Current task', 'waiting_input'))
                    expected = {'historical', 'live', 'outside'} if mode == 'harness' else {'historical', 'live'}
                    self.assertEqual(set(by_native), expected)
                    self.assertEqual(len(observed), len(expected), 'explicit and loaded results represent each session only once')
                    self.assertEqual('codex:outside' in state.data['identities'], mode == 'harness', 'project observation must not allocate an unapproved identity')
                    reads = [call['params'] for call in calls if call['method'] == 'thread/read']
                    self.assertEqual(reads.count({'threadId': 'historical', 'includeTurns': False}), 1)
                    self.assertEqual(reads.count({'threadId': 'live', 'includeTurns': False}), 1, 'a loaded explicit session needs only one read')
                    self.assertEqual(sum(call['method'] == 'initialize' for call in calls), 1, 'both reads share one connection and pass deadline')
                    self.assertFalse(any(call['method'] in {'thread/resume', 'thread/start'} for call in calls))
                    if loaded_available:
                        self.assertFalse(any(call['method'] == 'thread/list' for call in calls), 'mixed selections do not widen into an unnecessary history scan')

    def test_mixed_codex_unreadable_explicit_session_does_not_hide_loaded_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            state = State(directory)
            missing = state.identity('codex', 'missing')
            project = state.project('codex', '/fixture/subscribed')
            state.data['selections'] = [
                {'source_id': missing, 'harness': 'codex', 'mode': 'session', 'external_session_id': missing, 'include_future_sessions': False},
                {'source_id': project, 'harness': 'codex', 'mode': 'project', 'external_session_id': '', 'include_future_sessions': True},
            ]
            calls = []
            class Socket:
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def send(self, message):
                    self.message = json.loads(message)
                    if 'id' in self.message: calls.append(self.message)
                def recv(self, timeout):
                    method = self.message['method']
                    if method == 'thread/read' and self.message['params']['threadId'] == 'missing':
                        return json.dumps({'id': self.message['id'], 'error': {'code': -32602}})
                    result = ({'data': ['live']} if method == 'thread/loaded/list' else
                              {'thread': {'id': 'live', 'cwd': '/fixture/subscribed', 'name': 'Current task', 'status': {'type': 'active'}}}
                              if method == 'thread/read' else {})
                    return json.dumps({'id': self.message['id'], 'result': result})
            with patch.object(adapters, 'command_json', return_value={'status': 'running', 'socketPath': '/fixture/codex.sock'}), \
                 patch.object(adapters.Path, 'is_socket', return_value=True), patch.object(adapters, 'unix_connect', return_value=Socket()):
                observed = adapters.observe(state)
            self.assertEqual([(row.native_id, row.activity) for row in observed], [('live', 'working'), ('', 'unknown')])
            self.assertEqual(observed[1].id, missing)
            self.assertTrue(any(call['method'] == 'thread/read' and call['params']['threadId'] == 'missing' for call in calls))

    def test_server_mode_survives_response_validation(self):
        response = {'connector': {'id': 'connector', 'workspace_id': 'workspace', 'selections_revision': 1, 'selections': [], 'ingestion_mode': 'otlp'},
                    'credential': 'fixture-credential', 'credential_expires_at': '2099-01-01T00:00:00Z'}
        parsed = network.response_payload(json.dumps(response), 'POST', '/connectors')
        self.assertEqual(parsed['connector']['ingestion_mode'], 'otlp')

    def test_codex_short_poll_budgets_do_not_retry_one_hung_session_forever(self):
        now, poll_state, visited = [0.0], {}, set()
        class Socket:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def send(self, message): self.message = json.loads(message)
            def recv(self, timeout):
                method = self.message['method']
                native = self.message['params'].get('threadId', '')
                delay = 4 if method == 'initialize' else 10 if native.endswith('hung') else 0.1
                now[0] += min(delay, timeout)
                if timeout < delay: raise TimeoutError()
                result = ({'data': ['loaded-hung', 'loaded-ready']} if method == 'thread/loaded/list' else
                          {'thread': {'id': native}} if method == 'thread/read' else {})
                return json.dumps({'id': self.message['id'], 'result': result})
        def version(_command):
            now[0] += 8
            return {'status': 'running', 'socketPath': '/fixture/codex.sock'}
        with patch.object(adapters, 'command_json', side_effect=version), patch.object(adapters.Path, 'is_socket', return_value=True), \
             patch.object(adapters, 'unix_connect', side_effect=lambda *a, **k: Socket()), \
             patch.object(adapters.time, 'monotonic', side_effect=lambda: now[0]):
            for _ in range(8):
                now[0] = 0
                visited.update(row['id'] for row in adapters.codex_rows(['explicit-hung', 'explicit-ready'],
                               loaded_only=True, poll_state=poll_state))
                self.assertLessEqual(now[0], 14)
        self.assertEqual(visited, {'explicit-ready', 'loaded-ready'}, 'a shortened hung read must yield to other sessions on later polls')

    def test_mixed_codex_polls_rotate_slow_reads_without_starving_either_selection(self):
        for historical_delay, loaded_delay in ((4, 0.25), (0.25, 4), (4, 4)):
            with self.subTest(historical_delay=historical_delay, loaded_delay=loaded_delay), tempfile.TemporaryDirectory() as directory:
                state = State(directory)
                historical = [f'history-{index}' for index in range(4)]
                loaded = [f'live-{index}' for index in range(4)]
                identities = [state.identity('codex', native) for native in historical]
                project = state.project('codex', '/fixture/subscribed')
                state.data['selections'] = [
                    {'source_id': identity, 'harness': 'codex', 'mode': 'session',
                     'external_session_id': identity, 'include_future_sessions': False}
                    for identity in identities
                ] + [{'source_id': project, 'harness': 'codex', 'mode': 'project',
                      'external_session_id': '', 'include_future_sessions': True}]
                state.save()
                now, calls, visited = [0.0], [], set()
                class Socket:
                    def __enter__(self): return self
                    def __exit__(self, *args): pass
                    def send(self, message):
                        self.message = json.loads(message)
                        if 'id' in self.message: calls.append(self.message)
                    def recv(self, timeout):
                        method = self.message['method']
                        if method == 'thread/read':
                            native = self.message['params']['threadId']
                            delay = historical_delay if native in historical else loaded_delay
                            now[0] += min(delay, timeout)
                            if timeout < delay: raise TimeoutError()
                            result = {'thread': {'id': native, 'cwd': '/fixture/subscribed', 'name': native,
                                                  'status': {'type': 'active' if native in loaded else 'idle'}}}
                        else:
                            result = {'data': loaded} if method == 'thread/loaded/list' else {}
                        return json.dumps({'id': self.message['id'], 'result': result})
                with patch.object(adapters, 'command_json', return_value={'status': 'running', 'socketPath': '/fixture/codex.sock'}), \
                     patch.object(adapters.Path, 'is_socket', return_value=True), patch.object(adapters, 'unix_connect', side_effect=lambda *a, **k: Socket()), \
                     patch.object(adapters.time, 'monotonic', side_effect=lambda: now[0]):
                    for poll in range(6):
                        now[0] = 0.0; calls.clear()
                        observed = adapters.observe(State(directory))
                        visited.update(row.native_id for row in observed if row.native_id)
                        self.assertLessEqual(now[0], 14, 'rotation must retain the shared pass deadline')
                        self.assertIn('thread/loaded/list', [call['method'] for call in calls], 'history must not consume loaded discovery time')
                        reads = [call['params']['threadId'] for call in calls if call['method'] == 'thread/read']
                        self.assertEqual(len(reads), len(set(reads)), 'each native session gets at most one read per poll')
                        if poll == 0:
                            self.assertTrue(visited.intersection(loaded), 'a new running agent must be visible in the first poll')
                    self.assertEqual(visited, set(historical + loaded), 'both read queues must advance across bounded polls')

    def test_unsafe_existing_state_is_never_replaced_during_identity_allocation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text('{"identities": []}')
            path.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'unsafe_state'):
                State(directory)
            self.assertEqual(path.read_text(), '{"identities": []}')

    def test_broken_config_symlink_is_refused_without_replacing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.symlink_to(Path(directory) / 'missing-config')
            with self.assertRaisesRegex(ValueError, 'unsafe_state'):
                State(directory)
            self.assertTrue(path.is_symlink())
            self.assertFalse(path.exists())

    def test_connect_refuses_server_mode_mismatch_before_saving_connected_state(self):
        self.mode_rejected()

    def test_connect_refuses_receiver_that_does_not_report_its_mode(self):
        self.mode_rejected(returned=None)

    def test_mode_mismatch_stops_an_existing_observer_without_saving_new_credential(self):
        self.mode_rejected(existing=True)

    def mode_rejected(self, existing=False, returned='otlp'):
        with tempfile.TemporaryDirectory() as directory:
            state = State(directory)
            state.data['discovery_diagnostics'] = []
            if existing:
                state.data.update(origin='https://fixture.example', workspace_id='workspace', connector_id='existing', credential='old-scoped', observing=True, ingestion_mode='polling')
                state.save()
            candidate = adapters.Candidate(id='selected', harness='codex', project_id='project', label='Session', native_id='native')
            args = SimpleNamespace(queue_limit=1000, queue_byte_limit=1_000_000, refresh_seconds=60, origin='https://fixture.example',
                                   workspace_id='workspace', telemetry=False, select=['selected'], subscribe_project=[], subscribe_harness=[],
                                   yes=True, name='Fixture', no_start=True)
            def request(_origin, _token, method, path, body=None):
                if path == '/identity': return {'workspace_ids': ['workspace']}
                return {'connector': {'id': 'connector', 'selections_revision': 1, 'ingestion_mode': returned},
                        'credential': 'scoped-credential', 'credential_expires_at': '2099-01-01T00:00:00Z'}
            with patch.object(cli, 'enrollment_credential', return_value='enrollment'), patch.object(cli, 'request', side_effect=request), \
                 patch.object(cli, 'discover', return_value=[candidate]), patch.object(cli, 'stop'):
                with self.assertRaisesRegex(ValueError, 'ingestion_mode_mismatch'):
                    cli.connect(args, state)
            saved = State(directory).data
            if existing:
                self.assertEqual(saved['credential'], 'old-scoped'); self.assertEqual(saved['connector_id'], 'existing')
            else:
                self.assertNotIn('credential', saved); self.assertNotIn('connector_id', saved)
            self.assertTrue(saved['reconnect_required'])
            self.assertFalse(saved.get('observing', False))
