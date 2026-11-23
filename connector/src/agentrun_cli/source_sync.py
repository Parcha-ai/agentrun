"""Source-consented, one-way setup export. No network command may select export paths."""
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import re
from uuid import uuid4

from .learning_association import _origin, _project
from .network import APIError

SNAPSHOT_BYTES = 128 * 1024 * 1024
STATUS_CODES = {'unsupported_platform', 'source_changed', 'source_unavailable', 'snapshot_too_large'}
CONSENT = ('Setup sync exports this selected project\'s instructions, authored skills and all their assets, '
           'tool/settings requirements, tracked/dirty/untracked nonignored files, and bounded Git history. '
           'Native credentials and OAuth sign-ins stay on this machine. Unsupported or incomplete setup '
           'blocks Move; no source file is deleted. Future source changes keep syncing until disabled.')


class SnapshotExportError(ValueError):
    def __init__(self, code):
        self.code = code if code in STATUS_CODES else 'source_unavailable'
        super().__init__('Source snapshot is unavailable: ' + self.code)


def source_identity(target):
    return {key: target[key] for key in ('runtime', 'machine_id', 'project', 'selector')}


def approved_roots(target):
    # Computed only on the source during explicit enrollment/enable, never from a server response.
    roots = [target['project'], str(Path.home())]
    roots.extend(os.environ[name] for name in ('CODEX_HOME', 'CLAUDE_CONFIG_DIR') if os.environ.get(name))
    return sorted({str(Path(path).expanduser().absolute()) for path in roots})


def adoption(target, api_origin, connector_id, target_id):
    """Use the existing exact-project/origin, private-file and hook-ownership checks; never send its token."""
    if target['selector'] != {'kind': 'project'}:
        return None
    project = Path(target['project']).resolve(strict=True)
    found = _project(project, target['runtime'], _origin(api_origin))
    if found is None:
        return None
    _readiness, connection_id, token = found
    epoch = hashlib.sha256(token.encode()).hexdigest()
    message = json.dumps(['agentrun-source-sync-adoption-v1', connector_id, target_id,
                          connection_id, epoch, target['runtime'], target['machine_id'],
                          target['project'], target['selector']['kind'], None], ensure_ascii=False, separators=(',', ':'))
    return {'connection_id': connection_id, 'credential_epoch': epoch,
            'proof': hmac.new(token.encode(), message.encode(), hashlib.sha256).hexdigest()}


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def _private_read(path, limit):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > limit:
            raise ValueError('The private source-sync journal is unsafe or oversized; it was preserved.')
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('The private source-sync journal exceeds its limit; it was preserved.')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('The private source-sync journal is invalid; it was preserved.')
    return value


def _private_write(path, value, limit):
    raw = _json_bytes(value)
    if len(raw) > limit:
        raise ValueError('The complete source snapshot exceeds the sync transport limit; nothing was truncated.')
    temporary = path.parent / ('.sync-' + str(uuid4()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


class SourcePublisher:
    """One generation-pinned journal. Lost replies retry the exact payload, never silently regrant."""
    def __init__(self, state, bridge_factory, request):
        self.state, self.bridge_factory, self.request = state, bridge_factory, request
        self.initial = state._read()
        self.epoch = self._epoch(self.initial)
        self.directory = state.directory / 'source-sync' / self.epoch
        self.metadata = self.directory / 'metadata.json'
        self.pending = self.directory / 'pending.json'

    @staticmethod
    def _epoch(data):
        return hashlib.sha256(json.dumps({key: data.get(key) for key in (
            'origin', 'connector_id', 'credential', 'agent_id', 'targets', 'config_sync', 'sync_roots', 'disconnected')},
            sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()

    def _current(self):
        current = self.state._read()
        if (self._epoch(current) != self.epoch or current.get('disconnected') or
                current.get('config_sync') is not True or not current.get('credential')):
            raise ValueError('Source sync consent or destination changed; pending content was preserved without upload.')
        return current

    def _post(self, suffix, body, *, large=False):
        current = self._current()
        target_id = next(iter(current['targets']))
        if any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value) for value in (current['connector_id'], target_id)):
            raise ValueError('Invalid locally registered source target identity.')
        route = f"/v2/connectors/{current['connector_id']}/targets/{target_id}/sync{suffix}"
        reply = self.request(current['origin'], current['credential'], 'POST', route, body,
                             **({'max_bytes': SNAPSHOT_BYTES} if large else {}))
        self._current()
        return reply

    def _grant(self, current, target):
        # This idempotent endpoint returns the owner's existing switch; it never enables it.
        grant = self._post('/grant', {})
        if (grant.get('agent_id') != current['agent_id'] or grant.get('source') != source_identity(target)
                or type(grant.get('enabled')) is not bool or not isinstance(grant.get('generation'), str)
                or not 1 <= len(grant['generation']) <= 160 or type(grant.get('sequence')) is not int
                or not -1 <= grant['sequence'] < 2**53 - 1):
            raise ValueError('The destination did not confirm this exact source-sync grant.')
        return grant

    def once(self):
        if self.initial.get('config_sync') is not True:
            return {'status': 'off'}
        for directory in (self.directory.parent, self.directory):
            directory.mkdir(mode=0o700, exist_ok=True)
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError('The private source-sync journal directory is unsafe.')
        lock = os.open(self.state.directory / 'source-sync.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            current = self._current()
            if len(current.get('targets', {})) != 1 or not current.get('agent_id'):
                raise ValueError('Source sync needs one locally approved, imported target.')
            _target_id, target = next(iter(current['targets'].items()))
            metadata = _private_read(self.metadata, 64 * 1024) or {'epoch': self.epoch, 'next_sequence': 0}
            if metadata.get('epoch') != self.epoch:
                raise ValueError('Source sync journal belongs to a different consent epoch; it was preserved.')
            if metadata.get('blocked'):
                return {'status': 'blocked', 'reason': metadata['blocked']}
            stage = 'grant'
            try:
                pending = _private_read(self.pending, SNAPSHOT_BYTES)
                grant = self._grant(current, target)
                if not grant['enabled']:
                    return {'status': 'paused'}
                if grant['generation'] != metadata.get('generation'):
                    # A same-credential owner Off→On creates a new source generation. The old
                    # payload is retained for review, never relabeled or replayed into this one.
                    if pending is not None:
                        retained = self.directory / ('retained-' + str(uuid4()) + '.json')
                        os.rename(self.pending, retained)
                        pending = None
                    metadata = {'epoch': self.epoch, 'generation': grant['generation'],
                                'next_sequence': grant['sequence'] + 1}
                    _private_write(self.metadata, metadata, 64 * 1024)
                acknowledged_cleanup = pending is not None and pending.get('sequence') == metadata.get('next_sequence', 0) - 1 and (
                    (pending.get('code') in STATUS_CODES and pending['code'] == metadata.get('last_status')) or
                    ('snapshot' in pending and pending['snapshot'].get('digest') == metadata.get('last_digest') and not metadata.get('last_status')))
                if acknowledged_cleanup:
                    self.pending.unlink(); pending = None  # Acknowledged before an interrupted cleanup.
                if pending is None:
                    roots = current.get('sync_roots')
                    if not isinstance(roots, list) or not roots or any(not isinstance(root, str) or not Path(root).is_absolute() for root in roots):
                        raise ValueError('This connection has no locally approved source roots. Enable sync explicitly on the source.')
                    bridge = None; snapshot = None; failure = None
                    try:
                        bridge = self.bridge_factory(current.get('bridge'))
                        snapshot = bridge.call({'type': 'source-snapshot', 'target': target,
                                                # Private stdin only: the exporter must refuse copies of its own
                                                # scoped credential in project assets, never redact them into a
                                                # different snapshot or include this value in a network envelope.
                                                'payload': {'authorized_roots': roots,
                                                            'secret_values': [current['credential']]}}, timeout=60)
                    except SnapshotExportError as error:
                        failure = error.code
                    except (ValueError, OSError):
                        failure = 'source_unavailable'
                    finally:
                        if bridge is not None: bridge.close()
                    self._current()
                    if failure is None and (not isinstance(snapshot, dict) or snapshot.get('source') != source_identity(target)
                            or not isinstance(snapshot.get('digest'), str) or len(snapshot['digest']) != 64
                            or any(c not in '0123456789abcdef' for c in snapshot['digest'])):
                        failure = 'source_unavailable'
                    if failure is None and snapshot['digest'] == metadata.get('last_digest') and not metadata.get('last_status'):
                        return {'status': 'unchanged', 'digest': snapshot['digest']}
                    if failure is not None and failure == metadata.get('last_status'):
                        return {'status': 'blocked', 'reason': failure}
                    sequence = metadata.get('next_sequence')
                    if type(sequence) is not int or not 0 <= sequence < 2**53 - 1:
                        raise ValueError('Source sync sequence is exhausted or invalid; its journal was preserved.')
                    pending = {'generation': metadata['generation'], 'sequence': sequence,
                               **({'code': failure} if failure is not None else {'snapshot': snapshot})}
                    if len(_json_bytes(pending)) > SNAPSHOT_BYTES:
                        pending = {'generation': metadata['generation'], 'sequence': sequence, 'code': 'snapshot_too_large'}
                    _private_write(self.pending, pending, SNAPSHOT_BYTES)
                if (pending.get('generation') != metadata['generation'] or pending.get('sequence') != metadata['next_sequence']
                        or ('snapshot' in pending and pending['snapshot'].get('source') != source_identity(target))
                        or ('snapshot' not in pending and pending.get('code') not in STATUS_CODES)):
                    raise ValueError('Pending source content belongs to another generation or target; it was preserved.')
                failed = 'code' in pending
                stage = 'publish'
                acknowledged = self._post('/status' if failed else '', pending, large=not failed)
                if (acknowledged.get('generation') != metadata['generation'] or acknowledged.get('sequence') != pending['sequence']
                        or acknowledged.get('agent_id') != current['agent_id']
                        or (failed and acknowledged.get('attempt', {}).get('code') != pending['code'])
                        or (not failed and acknowledged.get('attempt', {}).get('digest') != pending['snapshot']['digest'])):
                    raise ValueError('The destination did not acknowledge this exact source snapshot.')
                metadata.update(next_sequence=pending['sequence'] + 1)
                if failed:
                    metadata['last_status'] = pending['code']
                else:
                    metadata.update(last_digest=pending['snapshot']['digest']); metadata.pop('last_status', None)
                _private_write(self.metadata, metadata, 64 * 1024)
                self.pending.unlink()
                return {'status': 'blocked', 'reason': pending['code']} if failed else {
                    'status': 'synced' if pending['snapshot'].get('complete') is True else 'blocked', 'digest': metadata['last_digest']}
            except APIError as error:
                if error.status == 403 and stage == 'publish':
                    # An owner toggle may race the upload. Check the same credential's authority;
                    # permission revocation still stops, but an explicit owner toggle can resume.
                    try:
                        grant = self._grant(current, target)
                    except APIError:
                        grant = None
                    if grant is not None and (not grant['enabled'] or grant['generation'] != metadata.get('generation')):
                        return {'status': 'paused'}
                if error.status in (401, 403):
                    metadata['blocked'] = 'Source sync authorization was revoked; explicitly authorize a fresh source connection.'
                    _private_write(self.metadata, metadata, 64 * 1024)
                raise
        finally:
            os.close(lock)
