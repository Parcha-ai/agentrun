"""Source consent and durable upload retries, with no native session or external service."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from agentrun_cli.source_sync import SourcePublisher, SnapshotExportError, SNAPSHOT_BYTES, adoption, source_identity
from agentrun_cli.state import State
from agentrun_cli.network import APIError


class SyncBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.project = self.root / 'project'; self.project.mkdir()
        self.state = State(self.root / 'state')
        self.target = {'runtime': 'codex', 'project': str(self.project), 'machine_id': 'machine', 'selector': {'kind': 'project'}}
        self.state.data.update(origin='https://receiver.example.invalid', connector_id='connector', credential='scoped-fixture',
                               agent_id='cli-fixture', remote=True, disconnected=False, config_sync=True,
                               targets={'target': self.target}, sync_roots=[str(self.project)])
        self.state.save()
        self.digest = 'a' * 64; self.exports = []; self.posts = []; self.loss = False; self.reject = False

    def bridge(self, _path):
        owner = self
        class Exporter:
            def call(self, message, **kwargs):
                owner.exports.append(message)
                return {'version': 1, 'source': source_identity(owner.target), 'digest': owner.digest, 'complete': True, 'blobs': {}}
            def close(self):
                pass
        return Exporter()

    def request(self, origin, credential, method, route, body, **kwargs):
        self.assertEqual(origin, 'https://receiver.example.invalid'); self.assertEqual(credential, 'scoped-fixture')
        self.posts.append((route, json.loads(json.dumps(body)), kwargs))
        if route.endswith('/grant'):
            return {'agent_id': 'cli-fixture', 'source': source_identity(self.target), 'enabled': True, 'generation': 'source-epoch', 'sequence': -1}
        if route.endswith('/status'):
            self.assertNotIn('max_bytes', kwargs)
            return {'agent_id': 'cli-fixture', 'generation': body['generation'], 'sequence': body['sequence'], 'attempt': {'code': body['code']}}
        self.assertEqual(kwargs['max_bytes'], SNAPSHOT_BYTES)
        if self.reject:
            raise APIError(403, {})
        if self.loss:
            self.loss = False
            raise OSError('Synthetic lost response')
        return {'agent_id': 'cli-fixture', 'generation': body['generation'], 'sequence': body['sequence'],
                'attempt': {'digest': body['snapshot']['digest']}}

    def publisher(self):
        return SourcePublisher(self.state, self.bridge, self.request)

    def test_old_state_does_not_gain_export_consent(self):
        self.state.data.pop('config_sync'); self.state.save()
        self.assertEqual(self.publisher().once(), {'status': 'off'})
        self.assertEqual(self.posts, []); self.assertEqual(self.exports, [])

    def test_new_grant_exports_only_saved_target_and_roots_then_noops(self):
        publisher = self.publisher()
        self.assertEqual(publisher.once()['status'], 'synced')
        self.assertEqual(self.exports[0]['target'], self.target)
        self.assertEqual(self.exports[0]['payload'], {'authorized_roots': [str(self.project)], 'secret_values': ['scoped-fixture']})
        self.assertNotIn('scoped-fixture', json.dumps(self.posts), 'held values stay in local bridge IPC, not request bodies')
        self.assertEqual(publisher.once()['status'], 'unchanged')
        self.assertEqual(len([p for p in self.posts if not p[0].endswith('/grant')]), 1)
        self.assertEqual(len([p for p in self.posts if p[0].endswith('/grant')]), 2)
        self.assertEqual(publisher.metadata.stat().st_mode & 0o777, 0o600)

    def test_uncertain_reply_retries_same_sequence_and_bytes_before_new_source(self):
        self.loss = True
        with self.assertRaises(OSError):
            self.publisher().once()
        self.digest = 'b' * 64
        self.assertEqual(self.publisher().once()['status'], 'synced')
        uploads = [p for p in self.posts if not p[0].endswith('/grant')]
        self.assertEqual(uploads[0][1], uploads[1][1]); self.assertEqual(len(self.exports), 1)
        self.assertEqual(self.publisher().once()['status'], 'synced')
        self.assertEqual(self.posts[-1][1]['sequence'], 1)
        self.assertEqual(self.posts[-1][1]['snapshot']['digest'], 'b' * 64)

    def test_revocation_retains_payload_and_never_automatically_regrants(self):
        self.reject = True
        with self.assertRaises(APIError):
            self.publisher().once()
        pending = self.publisher().pending.read_bytes()
        self.reject = False; previous_posts = len(self.posts)
        self.assertEqual(self.publisher().once()['status'], 'blocked')
        self.assertEqual(len(self.posts), previous_posts, 'denied authority is not polled or regranted automatically')
        self.assertEqual(self.publisher().pending.read_bytes(), pending)

    def test_owner_off_on_resumes_same_worker_with_fresh_snapshot_and_preserves_old_pending(self):
        grant = {'agent_id': 'cli-fixture', 'source': source_identity(self.target), 'enabled': True,
                 'generation': 'source-epoch', 'sequence': -1}
        def request(origin, credential, method, route, body, **kwargs):
            if route.endswith('/grant'):
                self.posts.append((route, dict(body), kwargs)); return dict(grant)
            return self.request(origin, credential, method, route, body, **kwargs)
        publisher = SourcePublisher(self.state, self.bridge, request)
        self.loss = True
        with self.assertRaises(OSError): publisher.once()
        pending = publisher.pending.read_bytes(); exported = len(self.exports)
        grant.update(enabled=False, generation='owner-disabled')
        self.assertEqual(publisher.once(), {'status': 'paused'})
        self.assertEqual(len(self.exports), exported)
        self.assertEqual(publisher.pending.read_bytes(), pending)
        self.assertEqual(publisher.once(), {'status': 'paused'})
        grant.update(enabled=True, generation='owner-enabled', sequence=-1)
        self.digest = 'b' * 64
        self.assertEqual(publisher.once()['status'], 'synced')
        self.assertEqual(self.posts[-1][1]['generation'], 'owner-enabled')
        self.assertEqual(self.posts[-1][1]['sequence'], 0)
        self.assertEqual(self.posts[-1][1]['snapshot']['digest'], self.digest)
        self.assertEqual(len(self.exports), exported + 1)
        archived = list(publisher.directory.glob('retained-*.json'))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_bytes(), pending)

    def test_owner_disable_racing_upload_pauses_instead_of_revoking_source_consent(self):
        disabled = False
        def request(origin, credential, method, route, body, **kwargs):
            nonlocal disabled
            if route.endswith('/grant') and disabled:
                return {'agent_id': 'cli-fixture', 'source': source_identity(self.target), 'enabled': False,
                        'generation': 'owner-off', 'sequence': -1}
            if not route.endswith('/grant'):
                disabled = True
                raise APIError(403, {})
            return self.request(origin, credential, method, route, body, **kwargs)
        publisher = SourcePublisher(self.state, self.bridge, request)
        self.assertEqual(publisher.once(), {'status': 'paused'})
        self.assertTrue(publisher.pending.exists())
        self.assertNotIn('blocked', json.loads(publisher.metadata.read_text()))

    def test_destination_or_credential_change_never_migrates_pending_content(self):
        self.loss = True; publisher = self.publisher()
        with self.assertRaises(OSError): publisher.once()
        before = len(self.posts); pending = publisher.pending.read_bytes()
        self.state.data['credential'] = 'replacement-fixture'; self.state.save()
        with self.assertRaisesRegex(ValueError, 'consent or destination changed'):
            publisher.once()
        self.assertEqual(len(self.posts), before)
        self.assertEqual(publisher.pending.read_bytes(), pending)
        replacement = self.publisher()
        self.assertNotEqual(replacement.pending, publisher.pending)
        self.assertFalse(replacement.pending.exists(), 'a fresh credential never inherits an old snapshot payload')

    def test_new_authorization_continues_server_sequence_without_old_epoch_payload(self):
        self.loss = True; previous = self.publisher()
        with self.assertRaises(OSError): previous.once()
        retained = previous.pending.read_bytes()
        self.state.data['credential'] = 'new-scoped-fixture'; self.state.save()
        posted = []
        def new_request(_origin, credential, _method, route, body, **_kwargs):
            self.assertEqual(credential, 'new-scoped-fixture'); posted.append(body)
            if route.endswith('/grant'):
                return {'agent_id': 'cli-fixture', 'source': source_identity(self.target), 'enabled': True,
                        'generation': 'source-epoch', 'sequence': 9}
            return {'agent_id': 'cli-fixture', 'generation': body['generation'], 'sequence': body['sequence'],
                    'attempt': {'digest': body['snapshot']['digest']}}
        self.digest = 'b' * 64
        self.assertEqual(SourcePublisher(self.state, self.bridge, new_request).once()['status'], 'synced')
        self.assertEqual(self.exports[-1]['payload']['secret_values'], ['new-scoped-fixture'])
        self.assertNotIn('new-scoped-fixture', json.dumps(posted), 'rotated credentials never enter snapshot envelopes')
        self.assertEqual(posted[-1]['sequence'], 10)
        self.assertEqual(posted[-1]['snapshot']['digest'], self.digest)
        self.assertEqual(previous.pending.read_bytes(), retained)

    def test_fixed_failure_status_preserves_last_good_and_republishes_same_content_after_recovery(self):
        publisher = self.publisher(); self.assertEqual(publisher.once()['status'], 'synced')
        original = publisher.bridge_factory
        class FailedExport:
            def call(self, *_args, **_kwargs): raise SnapshotExportError('source_changed')
            def close(self): pass
        publisher.bridge_factory = lambda _path: FailedExport()
        self.assertEqual(publisher.once(), {'status': 'blocked', 'reason': 'source_changed'})
        posted = self.posts[-1]
        self.assertTrue(posted[0].endswith('/sync/status'))
        self.assertEqual(posted[1], {'generation': 'source-epoch', 'sequence': 1, 'code': 'source_changed'})
        self.assertNotIn('snapshot', posted[1])
        count = len([p for p in self.posts if not p[0].endswith('/grant')]); publisher.once()
        self.assertEqual(len([p for p in self.posts if not p[0].endswith('/grant')]), count)
        publisher.bridge_factory = original
        self.assertEqual(publisher.once()['status'], 'synced', 'a good digest must clear the later failure even when unchanged')
        self.assertEqual(self.posts[-1][1]['sequence'], 2)
        self.assertEqual(self.posts[-1][1]['snapshot']['digest'], self.digest)

    def test_failure_exception_text_never_leaves_source(self):
        class FailedExport:
            def call(self, *_args, **_kwargs): raise ValueError('private source path and content fixture')
            def close(self): pass
        publisher = SourcePublisher(self.state, lambda _path: FailedExport(), self.request)
        self.assertEqual(publisher.once(), {'status': 'blocked', 'reason': 'source_unavailable'})
        self.assertNotIn('private source path', json.dumps(self.posts))

    def test_local_disable_during_export_prevents_network_upload(self):
        original = self.bridge
        def factory(path):
            exporter = original(path); call = exporter.call
            def changed(*args, **kwargs):
                snapshot = call(*args, **kwargs)
                self.state.data['config_sync'] = False; self.state.save()
                return snapshot
            exporter.call = changed
            return exporter
        with self.assertRaisesRegex(ValueError, 'consent or destination changed'):
            SourcePublisher(self.state, factory, self.request).once()
        self.assertEqual(len(self.posts), 1, 'the grant may exist, but no snapshot crossed the revoked local consent')

    def test_pending_journal_requires_private_ownership_and_permissions(self):
        self.loss = True
        with self.assertRaises(OSError): self.publisher().once()
        os.chmod(self.publisher().pending, 0o644)
        before = len(self.posts)
        with self.assertRaisesRegex(ValueError, 'unsafe or oversized'): self.publisher().once()
        self.assertEqual(len(self.posts), before)

    def test_adoption_proof_is_bound_to_origin_checked_credential_epoch_and_target(self):
        token = 'fixture-source-credential'
        with mock.patch('agentrun_cli.source_sync._project', return_value=('ready', 'connection', token)) as lookup:
            result = adoption(self.target, 'https://receiver.example.invalid:443/', 'connector', 'target')
        lookup.assert_called_once_with(self.project, 'codex', ('https', 'receiver.example.invalid', 443))
        epoch = hashlib.sha256(token.encode()).hexdigest()
        message = json.dumps(['agentrun-source-sync-adoption-v1', 'connector', 'target', 'connection', epoch,
                              'codex', 'machine', str(self.project), 'project', None], separators=(',', ':'))
        self.assertEqual(result, {'connection_id': 'connection', 'credential_epoch': epoch,
                                 'proof': hmac.new(token.encode(), message.encode(), hashlib.sha256).hexdigest()})
        self.assertNotIn(token, json.dumps(result))
        with mock.patch('agentrun_cli.source_sync._project', side_effect=ValueError('unmatched_learning_receipt')):
            with self.assertRaises(ValueError): adoption(self.target, 'https://other.example.invalid', 'connector', 'target')


if __name__ == '__main__':
    unittest.main()
