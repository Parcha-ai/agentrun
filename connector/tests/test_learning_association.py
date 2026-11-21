"""Source proof binds configured project hooks, never observation consent to learning."""
import hashlib
import hmac
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agentrun_cli.adapters import candidates
from agentrun_cli.learning_association import discover_learning, session_role
from agentrun_cli.queue import Queue
from agentrun_cli.state import State
from agentrun_cli import daemon
from agentrun_cli.network import response_payload


class LearningAssociations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.project = self.directory / 'project'; self.project.mkdir()
        self.data = self.directory / 'private-data'; self.data.mkdir()
        self.origin = 'http://127.0.0.1:7340'
        self.token = 'ar_cli_' + 'k' * 43
        self.connection_id = 'a' * 32
        self.candidate = SimpleNamespace(harness='codex', native_id='native-session', id='opaque-session',
                                         project_path=str(self.project), session_role='root', activity='idle')

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value)); path.chmod(0o600)

    def install(self, runtime='codex'):
        events = ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'] if runtime == 'codex' else ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']
        self.handlers = {event: {'type': 'command', 'command': 'fixture-owned-hook', 'timeout': 5} for event in events}
        self.receipt = self.project / '.agentrun' / 'cli-learning' / (runtime + '.json')
        self.write(self.receipt, {'version': 1, 'project': str(self.project), 'runtime': runtime,
                                 'dataDir': str(self.data), 'url': self.origin, 'handlers': self.handlers,
                                 'hadHooks': False, 'createdEvents': events})
        key = hashlib.sha256((runtime + '\0' + str(self.project)).encode()).hexdigest()
        self.connection = self.data / 'cli-learning' / 'connections' / (key + '.json')
        self.write(self.connection, {'version': 1, 'project': str(self.project), 'runtime': runtime,
                                    'url': self.origin, 'connection_id': self.connection_id, 'token': self.token})
        self.config = self.project / ('.codex' if runtime == 'codex' else '.claude') / ('hooks.json' if runtime == 'codex' else 'settings.local.json')
        self.write(self.config, {'hooks': {event: [{'hooks': [handler]}] for event, handler in self.handlers.items()}})

    def discover(self, cache=None):
        return discover_learning(self.candidate, self.origin, cache)

    def linked_worktree(self):
        common = self.directory / 'main' / '.git'; common.mkdir(parents=True, exist_ok=True)
        gitdir = common / 'worktrees' / 'fixture'; gitdir.mkdir(parents=True, exist_ok=True)
        (self.project / '.git').write_text(f'gitdir: {gitdir}\n')
        (gitdir / 'commondir').write_text('../..\n')
        (gitdir / 'gitdir').write_text(str(self.project / '.git') + '\n')
        return gitdir

    def install_shared(self):
        self.install(); self.linked_worktree()
        receipt = json.loads(self.receipt.read_text())
        self.write(self.receipt, {**receipt, 'version': 2, 'format': 'codex-shared-json',
                                 'configRoot': str(self.directory / 'main')})
        config = json.loads(self.config.read_text())
        self.config.unlink()
        self.config = self.directory / 'main' / '.codex' / 'hooks.json'
        self.write(self.config, config)

    def test_linked_worktree_json_is_not_effective_native_hook_configuration(self):
        self.install(); self.linked_worktree()
        association = self.discover()
        self.assertEqual(association.readiness, 'setup_required')
        self.assertEqual(association.connection_id, self.connection_id)
        child = self.project / 'package'; child.mkdir(); self.candidate.project_path = str(child)
        self.assertEqual(self.discover().readiness, 'setup_required')

    def test_worktree_shared_receipt_binds_only_exact_owned_handlers(self):
        self.install_shared()
        self.assertEqual(self.discover().readiness, 'ready')
        original = self.config.read_text()
        self.config.write_text(original.replace('fixture-owned-hook', 'different-command', 1))
        self.assertEqual(self.discover().readiness, 'setup_required')
        self.config.write_text(original)
        self.assertEqual(self.discover().readiness, 'ready')
        self.config.unlink()
        self.assertEqual(self.discover().readiness, 'setup_required')

    def test_shared_receipt_does_not_accept_local_fallback_or_wrong_runtime(self):
        self.install_shared()
        self.config.unlink()
        self.write(self.project / '.codex' / 'hooks.json', {'hooks': {event: [{'hooks': [handler]}] for event, handler in self.handlers.items()}})
        self.assertEqual(self.discover().readiness, 'setup_required')
        receipt = json.loads(self.receipt.read_text())
        self.write(self.receipt, {**receipt, 'format': 'codex-toml'})
        self.assertEqual(self.discover().readiness, 'unknown')
        self.install('claude-code'); self.candidate.harness = 'claude'
        receipt = json.loads(self.receipt.read_text())
        self.write(self.receipt, {**receipt, 'version': 2, 'format': 'codex-shared-json'})
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_unsafe_or_malformed_shared_config_and_git_metadata_are_unknown(self):
        self.install_shared(); original = self.config.read_text()
        for invalid in ['{invalid', ' ' * 65537]:
            self.config.write_text(invalid)
            self.assertEqual(self.discover().readiness, 'unknown')
        self.config.write_text(original)
        target = self.directory / 'external.json'; self.config.rename(target); self.config.symlink_to(target)
        self.assertEqual(self.discover().readiness, 'unknown')
        self.config.unlink(); self.install()
        gitdir = self.linked_worktree(); common = gitdir / 'commondir'
        target = self.directory / 'external-common'; common.rename(target); common.symlink_to(target)
        self.assertEqual(self.discover().readiness, 'unknown')
        common.unlink(); common.write_text('../..\n')
        (self.project / '.git').write_text('not-a-gitdir')
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_submodule_gitfile_keeps_ordinary_json_hooks(self):
        self.install()
        gitdir = self.directory / 'main' / '.git' / 'modules' / 'fixture'; gitdir.mkdir(parents=True)
        (self.project / '.git').write_text(f'gitdir: {gitdir}\n')
        self.assertEqual(self.discover().readiness, 'ready')

    def test_shared_migration_receipt_cannot_point_at_another_owned_install(self):
        self.install_shared()
        receipt = json.loads(self.receipt.read_text())
        legacy = {key: value for key, value in receipt.items() if key != 'format'}; legacy['version'] = 1
        self.write(self.receipt, {**receipt, 'legacy': legacy})
        self.assertEqual(self.discover().readiness, 'ready')
        for mismatch in [{'project': str(self.directory)}, {'runtime': 'claude-code'}, {'dataDir': str(self.directory)},
                         {'url': 'http://127.0.0.1:7341'}, {'handlers': {}}, {'version': True}]:
            self.write(self.receipt, {**receipt, 'legacy': {**legacy, **mismatch}})
            self.assertEqual(self.discover().readiness, 'unknown')

    def test_shared_config_does_not_treat_boolean_or_nonfinite_timeout_as_owned_number(self):
        self.install_shared(); original = self.config.read_text()
        for value, expected in [('true', 'setup_required'), ('NaN', 'unknown'), ('Infinity', 'unknown')]:
            self.config.write_text(original.replace('"timeout": 5', '"timeout": ' + value, 1))
            self.assertEqual(self.discover().readiness, expected)
        self.config.write_text(original)
        self.assertEqual(self.discover().readiness, 'ready')

    def test_shared_root_must_be_derived_from_reciprocal_git_ownership(self):
        self.install_shared()
        receipt = json.loads(self.receipt.read_text())
        self.write(self.receipt, {**receipt, 'configRoot': str(self.directory)})
        self.assertEqual(self.discover().readiness, 'unknown')
        self.write(self.receipt, receipt)
        gitdir = self.directory / 'main' / '.git' / 'worktrees' / 'fixture'
        (gitdir / 'gitdir').write_text(str(self.directory / 'other' / '.git'))
        self.assertEqual(self.discover().readiness, 'unknown')
        (gitdir / 'gitdir').write_text(str(self.project / '.git'))
        (gitdir / 'commondir').write_text(str(self.directory))
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_nested_enrollment_uses_corresponding_shared_project_directory(self):
        self.linked_worktree()
        self.project = self.project / 'packages' / 'component'; self.project.mkdir(parents=True)
        self.candidate.project_path = str(self.project)
        self.install()
        root = self.directory / 'main' / 'packages' / 'component'; root.mkdir(parents=True)
        receipt = json.loads(self.receipt.read_text())
        self.write(self.receipt, {**receipt, 'version': 2, 'format': 'codex-shared-json', 'configRoot': str(root)})
        config = json.loads(self.config.read_text()); self.config.unlink(); self.config = root / '.codex' / 'hooks.json'
        self.write(self.config, config)
        self.assertEqual(self.discover().readiness, 'ready')

    def test_shared_empty_groups_and_other_projects_do_not_supply_missing_owned_hooks(self):
        self.install_shared()
        config = json.loads(self.config.read_text())
        for groups in config['hooks'].values(): groups.insert(0, {'hooks': []})
        self.write(self.config, config)
        self.assertEqual(self.discover().readiness, 'ready')
        config['hooks']['Stop'][1]['hooks'][0]['command'] = 'another-project-hook'
        self.write(self.config, config)
        self.assertEqual(self.discover().readiness, 'setup_required')

    def test_shared_hooks_still_require_a_real_worktree_config_scope(self):
        self.install_shared()
        scope = self.project / '.codex'; scope.rmdir()
        self.assertEqual(self.discover().readiness, 'setup_required')
        target = self.directory / 'another-scope'; target.mkdir(); scope.symlink_to(target)
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_unenrolled_nested_checkout_cannot_inherit_outer_learning_connection(self):
        self.install(); (self.project / '.git').mkdir()
        nested = self.project / 'nested'; nested.mkdir(); (nested / '.git').mkdir()
        self.candidate.project_path = str(nested)
        association = self.discover()
        self.assertEqual(association.readiness, 'setup_required')
        self.assertIsNone(association.connection_id)

    def test_unenrolled_nested_worktree_cannot_bind_main_checkout_profile(self):
        self.install(); common = self.project / '.git'; common.mkdir()
        nested = self.project / 'nested'; nested.mkdir()
        gitdir = common / 'worktrees' / 'inner'; gitdir.mkdir(parents=True)
        (nested / '.git').write_text(f'gitdir: {gitdir}\n')
        (gitdir / 'commondir').write_text('../..\n')
        (gitdir / 'gitdir').write_text(str(nested / '.git') + '\n')
        self.candidate.project_path = str(nested)
        association = self.discover()
        self.assertEqual(association.metadata('connector', 'source', 'session', 1), {'readiness': 'setup_required'})

    def test_shared_mapping_refuses_symlink_in_intermediate_project_components(self):
        self.linked_worktree()
        self.project = self.project / 'packages' / 'component'; self.project.mkdir(parents=True)
        self.candidate.project_path = str(self.project); self.install()
        external = self.directory / 'external'; external.mkdir(); (external / 'component').mkdir()
        (self.directory / 'main' / 'packages').symlink_to(external)
        receipt = json.loads(self.receipt.read_text())
        self.write(self.receipt, {**receipt, 'version': 2, 'format': 'codex-shared-json',
                                 'configRoot': str(external / 'component')})
        self.write(external / 'component' / '.codex' / 'hooks.json', json.loads(self.config.read_text()))
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_symlinked_or_oversized_gitfile_is_unknown_not_ready(self):
        self.install(); self.linked_worktree()
        marker = self.project / '.git'; original = marker.read_text()
        marker.write_text('gitdir: ' + 'x' * 65536)
        self.assertEqual(self.discover().readiness, 'unknown')
        marker.unlink(); target = self.directory / 'gitfile'; target.write_text(original); marker.symlink_to(target)
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_exact_project_configuration_yields_proof_not_claim_of_activation(self):
        self.install()
        association = self.discover()
        self.assertEqual(association.readiness, 'ready')
        metadata = association.metadata('connector', 'source', self.candidate.id, 7)
        native_hash = hashlib.sha256(b'native-session').hexdigest()
        canonical = json.dumps(['agentrun-cli-learning-observation-v1', 'connector', 'source', 'opaque-session',
                                'codex', self.connection_id, 'ready', native_hash, 7], separators=(',', ':'))
        expected = hmac.new(self.token.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(metadata, {'readiness': 'ready', 'connection_id': self.connection_id,
                                   'native_session_hash': native_hash, 'proof': expected})
        self.assertNotIn('enabled', metadata)
        self.assertNotIn(self.token, repr(association))
        for private in [str(self.project), str(self.data), self.token, 'native-session']:
            self.assertNotIn(private, json.dumps(metadata))
        self.assertNotEqual(metadata['proof'], association.metadata('another-connector', 'source', self.candidate.id, 7)['proof'])
        self.assertNotEqual(metadata['proof'], association.metadata('connector', 'source', self.candidate.id, 8)['proof'])

    def test_subdirectory_uses_ancestor_receipt_but_same_basename_elsewhere_does_not(self):
        self.install()
        child = self.project / 'packages' / 'console'; child.mkdir(parents=True)
        self.candidate.project_path = str(child)
        self.assertEqual(self.discover().connection_id, self.connection_id)
        other = self.directory / 'different' / 'project'; other.mkdir(parents=True)
        self.candidate.project_path = str(other)
        self.assertEqual(self.discover().readiness, 'setup_required')

    def test_missing_config_and_disabled_or_modified_hooks_need_setup(self):
        self.install()
        for config in [{}, {'disableAllHooks': True, 'hooks': {event: [{'hooks': [handler]}] for event, handler in self.handlers.items()}},
                       {'hooks': {event: [{'matcher': 'not-all', 'hooks': [handler]}] for event, handler in self.handlers.items()}}]:
            self.write(self.config, config)
            association = self.discover()
            self.assertEqual(association.readiness, 'setup_required')
            self.assertEqual(association.connection_id, self.connection_id, 'known profile remains available for repair')
        self.config.unlink()
        self.assertEqual(self.discover().readiness, 'setup_required')

    def test_unreadable_mismatched_and_nonprivate_credentials_are_unknown(self):
        self.install()
        original = json.loads(self.connection.read_text())
        for patch_values in [{'project': str(self.directory)}, {'runtime': 'claude-code'}, {'url': 'http://127.0.0.1:7341'}]:
            self.write(self.connection, {**original, **patch_values})
            self.assertEqual(self.discover().readiness, 'unknown')
        self.write(self.connection, original); self.connection.chmod(0o644)
        self.assertEqual(self.discover().readiness, 'unknown')
        self.connection.chmod(0o600); self.connection.write_text('{not-json')
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_other_destination_never_gets_association_or_credential_proof(self):
        self.install()
        association = discover_learning(self.candidate, 'https://different.example')
        self.assertEqual(association.metadata('connector', 'source', 'session', 1), {'readiness': 'unknown'})

    def test_delegated_and_unknown_sessions_do_not_read_credentials(self):
        self.install()
        for role, expected in [('delegated', 'unsupported'), ('unknown', 'unknown')]:
            self.candidate.session_role = role
            with patch('agentrun_cli.learning_association._project', side_effect=AssertionError('must not inspect source files')):
                self.assertEqual(self.discover().readiness, expected)
        self.assertEqual(session_role('codex', {'source': {'subAgent': {'thread_spawn': {}}}}), 'delegated')
        self.assertEqual(session_role('codex', {'source': 'appServer'}), 'root')
        self.assertEqual(session_role('claude', {'agent_id': 'child'}), 'delegated')

    def test_claude_uses_its_own_runtime_receipt(self):
        self.install('claude-code'); self.candidate.harness = 'claude'
        association = self.discover()
        self.assertEqual((association.readiness, association.runtime), ('ready', 'claude-code'))
        self.candidate.harness = 'codex'
        self.assertEqual(self.discover().readiness, 'setup_required')

    def test_symlink_or_oversized_source_metadata_is_unknown(self):
        self.install()
        saved = self.receipt.read_bytes(); self.receipt.unlink()
        target = self.directory / 'linked.json'; target.write_bytes(saved); self.receipt.symlink_to(target)
        self.assertEqual(self.discover().readiness, 'unknown')
        self.receipt.unlink(); self.receipt.write_text(' ' * (65536 + 1))
        self.assertEqual(self.discover().readiness, 'unknown')

    def test_nonstandard_json_and_nonfinite_or_boolean_timeouts_are_unknown(self):
        self.install(); original_receipt = json.loads(self.receipt.read_text()); original_config = self.config.read_text()
        for value in [True, float('nan'), float('inf'), -float('inf'), 10 ** 400]:
            receipt = json.loads(json.dumps(original_receipt))
            receipt['handlers']['Stop']['timeout'] = value
            self.write(self.receipt, receipt)
            self.assertEqual(self.discover().readiness, 'unknown')
        self.write(self.receipt, original_receipt)
        for constant in ['NaN', 'Infinity', '-Infinity']:
            self.config.write_text(original_config[:-1] + ',"ignored":' + constant + '}')
            self.assertEqual(self.discover().readiness, 'unknown')
        self.config.write_text(original_config)
        for path in [self.receipt, self.connection]:
            original = json.loads(path.read_text()); self.write(path, {**original, 'version': True})
            self.assertEqual(self.discover().readiness, 'unknown')
            self.write(path, original)

    def test_one_pass_cache_does_not_hide_next_pass_configuration_changes(self):
        self.install(); cache = {}
        self.assertEqual(self.discover(cache).readiness, 'ready')
        self.write(self.config, {})
        self.assertEqual(self.discover(cache).readiness, 'ready')
        self.assertEqual(self.discover().readiness, 'setup_required')

    def test_source_identity_is_private_and_queue_signs_each_sequence_without_secrets(self):
        self.install(); state = State(self.directory / 'observer')
        candidate = candidates(state, 'codex', [{'id': 'native-session', 'cwd': str(self.project), 'source': 'appServer', 'status': {'type': 'idle'}}])[0]
        association = discover_learning(candidate, self.origin)
        self.assertEqual(association.readiness, 'ready')
        self.assertNotIn('project_path', candidate.public())
        self.assertNotIn('session_role', candidate.public())
        queue = Queue(state.directory, refresh_seconds=0); self.addCleanup(queue.close)
        queue.observe('source', candidate, cli_learning=association, connector_id='connector')
        queue.observe('source', candidate, cli_learning=association, connector_id='connector')
        events = queue.batch()
        self.assertNotEqual(events[0]['metadata']['cli_learning']['proof'], events[1]['metadata']['cli_learning']['proof'])
        persisted = '\n'.join(row[0] for row in queue.db.execute('SELECT payload FROM events')) + str(queue.db.execute('SELECT * FROM metadata_labels').fetchall())
        self.assertNotIn(self.token, persisted); self.assertNotIn(str(self.project), persisted)

    def test_learning_configuration_change_refreshes_idle_without_native_relaunch(self):
        self.install(); queue = Queue(self.directory); self.addCleanup(queue.close)
        queue.observe('source', self.candidate, cli_learning=self.discover(), connector_id='connector')
        first = queue.batch()[0]; queue.acknowledge([first['event_id']])
        queue.observe('source', self.candidate, cli_learning=self.discover(), connector_id='connector')
        self.assertEqual(queue.count(), 0)
        self.write(self.config, {})
        queue.observe('source', self.candidate, cli_learning=self.discover(), connector_id='connector')
        self.assertEqual(queue.batch()[0]['metadata']['cli_learning']['readiness'], 'setup_required')

    def test_legacy_queue_payload_contains_no_learning_metadata(self):
        queue = Queue(self.directory); self.addCleanup(queue.close)
        queue.observe('source', self.candidate)
        self.assertEqual(queue.batch()[0]['metadata'], {'harness': 'codex', 'activity': 'idle'})

    def daemon_setup(self, suffix):
        state = State(self.directory / suffix)
        candidate = candidates(state, 'codex', [{'id': 'native-session', 'cwd': str(self.project),
                                                'source': 'appServer', 'status': {'type': 'idle'}}])[0]
        selected = [{'source_id': candidate.id, 'harness': 'codex', 'mode': 'session',
                     'external_session_id': candidate.id, 'include_future_sessions': False}]
        state.data.update(origin=self.origin, workspace_id='personal:test', connector_id='connector', credential='fixture-key',
                          selections_revision=1, selections=selected, approved_selections=selected, observing=True)
        state.save()
        queue = Queue(state.directory); self.addCleanup(queue.close)
        queue.usage_capability_checked_at = 0
        return state, candidate, selected, queue

    def capabilities(self, supported):
        return {'version': 1, 'ingestion_modes': ['polling'], 'supported_harnesses': ['codex'], 'logs_formats': ['json'],
                'logs_endpoint_template': '/logs', 'selections_revision_header': 'X-Revision', 'max_log_records': 100,
                'max_payload_bytes': 65536, 'privacy': {}, **({'cli_learning': {'session_association': True}} if supported else {})}

    def test_daemon_only_reads_and_sends_associations_after_receiver_opt_in(self):
        self.install()
        for supported in [False, True]:
            state, candidate, selected, queue = self.daemon_setup(str(supported))
            delivered = []
            def request(_origin, _token, method, path, body=None):
                if path.endswith('/capabilities'):
                    return response_payload(json.dumps(self.capabilities(supported)), method, path)
                if path.endswith('/heartbeat'):
                    return {'selections_revision': 1, 'selections': selected}
                delivered.extend(body['events'])
                return {'accepted_event_ids': [event['event_id'] for event in body['events']]}
            with patch.object(daemon, 'request', request), patch.object(daemon, 'observe', return_value=[candidate]), \
                 patch.object(daemon, 'discover_learning', wraps=discover_learning) as discovered:
                self.assertEqual(daemon.tick(state, queue), 'delivered')
            self.assertEqual(discovered.call_count, int(supported))
            self.assertEqual('cli_learning' in delivered[0]['metadata'], supported)
            self.assertEqual(queue.count(), 0)

    def test_association_lookup_cannot_publish_after_consent_is_removed(self):
        self.install(); state, candidate, selected, queue = self.daemon_setup('fence')
        def request(_origin, _token, method, path, body=None):
            if path.endswith('/capabilities'):
                return self.capabilities(True)
            if path.endswith('/heartbeat'):
                return {'selections_revision': 1, 'selections': selected}
            self.fail('no event should leave the removed consent epoch')
        def lookup(*args):
            writer = State(state.directory); writer.data['observing'] = False; writer.save()
            return discover_learning(*args)
        with patch.object(daemon, 'request', request), patch.object(daemon, 'observe', return_value=[candidate]), \
             patch.object(daemon, 'discover_learning', lookup):
            self.assertEqual(daemon.tick(state, queue), 'connection_changed')
        self.assertEqual(queue.count(), 0)

    def test_token_rotation_changes_proof_and_checkpoint_without_retaining_old_token(self):
        self.install(); queue = Queue(self.directory); self.addCleanup(queue.close)
        queue.observe('source', self.candidate, cli_learning=self.discover(), connector_id='connector')
        first = queue.batch()[0]; queue.acknowledge([first['event_id']])
        value = json.loads(self.connection.read_text()); value['token'] = 'ar_cli_' + 'z' * 43
        self.write(self.connection, value)
        queue.observe('source', self.candidate, cli_learning=self.discover(), connector_id='connector')
        second = queue.batch()[0]
        self.assertNotEqual(first['metadata']['cli_learning']['proof'], second['metadata']['cli_learning']['proof'])
        persisted = str(queue.db.execute('SELECT * FROM metadata_labels').fetchall())
        self.assertNotIn(value['token'], persisted); self.assertNotIn(self.token, persisted)

    def test_association_and_usage_still_fit_unicode_delivery_byte_limits(self):
        self.install(); state = State(self.directory / 'unicode')
        candidate = candidates(state, 'codex', [{'id': 'native-session', 'cwd': str(self.project),
                                                'name': '修' * 120, 'source': 'appServer', 'status': {'type': 'idle'}}])[0]
        candidate = candidate.model_copy(update={'project_name': '界' * 80})
        queue = Queue(state.directory); self.addCleanup(queue.close)
        for index in range(100):
            queue.observe('s' * 128, candidate.model_copy(update={'id': 'e' * 125 + f'{index:03d}'}),
                          collect_labels=True, cli_learning=discover_learning(candidate, self.origin), connector_id='connector')
        delivered = []
        while queue.count():
            batch = queue.batch(); self.assertTrue(batch)
            self.assertLessEqual(len(json.dumps({'selections_revision': (1 << 53) - 1, 'events': batch}).encode()), 65536)
            delivered.extend(batch); queue.acknowledge([event['event_id'] for event in batch])
        self.assertEqual(len(delivered), 100)
