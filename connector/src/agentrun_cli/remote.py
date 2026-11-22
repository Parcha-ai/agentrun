"""Explicit source-machine native execution through a scoped outbound OSS connection.

The existing observer is unchanged. Remote execution is separately selected and sends
run content only for the one registered source target. Credentials never enter argv.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import fcntl
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import signal
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from uuid import uuid4

from . import __version__
from .network import APIError, NoRedirect, origin, read_credential
from .state import State
from .source_sync import SourcePublisher, SnapshotExportError, SNAPSHOT_BYTES, CONSENT as SYNC_CONSENT, approved_roots, adoption

MAX_BYTES = 4_000_000
CANCEL_WRITE_SECONDS = .25
BRIDGE_STOPPED = 'The source bridge stopped; an uncertain native operation is not replayed.'


def identifier(value):
    if not isinstance(value, str) or not value or len(value) > 160 or any(not (c.isascii() and (c.isalnum() or c in '_-')) for c in value):
        raise ValueError('Invalid connector or command identity.')
    return value


def request(api_origin, credential, method, route, body=None, *, max_bytes=MAX_BYTES):
    """No redirect and no observer response coercion; this is the versioned OSS protocol."""
    raw = None if body is None else json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode()
    if max_bytes not in (MAX_BYTES, SNAPSHOT_BYTES) or (max_bytes != MAX_BYTES and not route.endswith('/sync')):
        raise ValueError('Only the source-sync endpoint accepts a snapshot envelope.')
    if raw is not None and len(raw) > max_bytes:
        raise ValueError('Remote request exceeds its size limit.')
    if not route.startswith('/v2/connectors') or '\n' in route or '\r' in route:
        raise ValueError('Invalid connector route.')
    req = Request(origin(api_origin) + route, data=raw, method=method,
                  headers={'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json'})
    try:
        with build_opener(NoRedirect).open(req, timeout=10) as response:
            data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError('Remote response exceeds its size limit.')
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError('Invalid connector response.')
            return result
    except HTTPError as error:
        try:
            detail = json.loads(error.read(65536))
        except (ValueError, HTTPException, OSError):
            detail = {}
        raise APIError(error.code, detail) from None
    except HTTPException:
        # A partial response cannot acknowledge a durable payload. Keep it retryable without
        # letting source-sync transport failure terminate unrelated native execution.
        raise OSError('The remote response was incomplete or invalid.') from None


def epoch(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value) or value < 0:
            raise ValueError('Invalid command expiry.')
        return value / 1000 if value > 100_000_000_000 else value
    if not isinstance(value, str):
        raise ValueError('Invalid command expiry.')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('The command expiry must identify its time zone.')
    return parsed.timestamp()


class Bridge:
    """One source bridge preserves native session identity across task and reflection turns."""
    def __init__(self, path=None, on_event=None, *, max_bytes=MAX_BYTES):
        if max_bytes not in (MAX_BYTES, SNAPSHOT_BYTES):
            raise ValueError('Invalid source bridge bound.')
        self.max_bytes = max_bytes
        command = ['node', str(Path(path).expanduser().resolve())] if path else ['agentrun-serve', 'remote-bridge']
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.pending, self.lock, self.write_lock = {}, threading.Lock(), threading.Lock()
        self.stopped, self.close_lock = threading.Event(), threading.Lock()
        self.on_event = on_event or (lambda message: None)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            while not self.stopped.is_set():
                # Bound bytes before decoding or waiting for a newline: a malformed
                # peer must not accumulate an unbounded text line in the reader.
                line = self.process.stdout.buffer.readline(self.max_bytes + 1)
                if not line:
                    break
                if len(line) > self.max_bytes:
                    raise ValueError('Source bridge response exceeds its limit.')
                message = json.loads(line.decode('utf-8'))
                if not isinstance(message, dict):
                    raise ValueError('Invalid source bridge response.')
                if 'event' in message:
                    self.on_event(message)
                    continue
                with self.lock:
                    waiting = self.pending.get(message.get('id'))
                if waiting:
                    waiting.put(message)
        except Exception:
            # Decode/protocol errors and a failed event sink all end this reader.
            pass
        finally:
            try:
                self._stop(failed=True)
            finally:
                self.process.stdout.close()

    def write(self, value, cancelled=None, *, deadline=None):
        if self.stopped.is_set():
            raise ValueError(BRIDGE_STOPPED)
        line = json.dumps(value, separators=(',', ':'))
        if len(line.encode()) > MAX_BYTES:
            raise ValueError('Source bridge request exceeds its limit.')
        acquired = self.write_lock.acquire() if deadline is None else self.write_lock.acquire(timeout=max(0, deadline - time.monotonic()))
        if not acquired:
            raise TimeoutError('Source bridge cancellation could not acquire the writer.')
        try:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError('Source bridge cancellation writer deadline elapsed.')
            if cancelled is not None and cancelled.is_set():
                raise ValueError('The destination cancelled this native operation before dispatch.')
            if self.stopped.is_set():
                raise ValueError(BRIDGE_STOPPED)
            try:
                self.process.stdin.write(line + '\n')
                self.process.stdin.flush()
            except (OSError, ValueError):
                if self.stopped.is_set():
                    raise ValueError(BRIDGE_STOPPED) from None
                raise
        finally:
            self.write_lock.release()

    def call(self, command, timeout=620, *, cancelled=None):
        command = {**command, 'id': command.get('id') or str(uuid4())}
        waiting = queue.Queue()
        with self.lock:
            if self.stopped.is_set():
                raise ValueError(BRIDGE_STOPPED)
            self.pending[command['id']] = waiting
        try:
            # Under the write lock, either cancellation prevents this frame or the
            # command frame is flushed before its following cancellation frame.
            self.write(command, cancelled=cancelled)
            result = waiting.get(timeout=timeout)
            if 'error' in result:
                if command.get('type') == 'source-snapshot':
                    raise SnapshotExportError(result.get('code'))
                raise ValueError(str(result['error']))
            if 'result' not in result:
                raise ValueError('Source bridge omitted its result.')
            return result['result']
        except queue.Empty:
            self.cancel(command['id'])
            raise ValueError('The source bridge timed out; inspect the native session before retrying.') from None
        finally:
            with self.lock:
                self.pending.pop(command['id'], None)

    def cancel(self, command_id):
        if self.stopped.is_set():
            return
        deadline = time.monotonic() + CANCEL_WRITE_SECONDS
        finished, failed = threading.Event(), threading.Event()

        def send():
            try:
                self.write({'id': str(uuid4()), 'type': 'cancel', 'command_id': command_id}, deadline=deadline)
            except (OSError, ValueError):
                failed.set()
            finally:
                finished.set()

        writer = threading.Thread(target=send, daemon=True, name=f'agentrun-bridge-cancel-{id(self)}')
        writer.start()
        if not finished.wait(max(0, deadline - time.monotonic())) or failed.is_set():
            # The deadline covers lock acquisition and pipe flush. Publish failure
            # and signal/reap before taking TextIO locks, releasing a blocked writer.
            # This shared bridge is now unusable; uncertain operations are not replayed.
            self._stop(failed=True)
        writer.join(timeout=CANCEL_WRITE_SECONDS)

    def _terminate(self):
        try:
            self.process.terminate()
        except OSError:
            pass  # It may already have exited.

    def _stop(self, failed=False):
        # Publish the terminal state before waking a caller: its next command must not
        # reach a still-live child whose replies no reader can consume.
        with self.lock:
            if not self.stopped.is_set():
                self.stopped.set()
                for waiting in self.pending.values():
                    waiting.put({'error': BRIDGE_STOPPED})
        # Signal before any lifecycle or TextIO lock: a concurrent flush may hold
        # stdin's lock while the child has stopped reading. SIGTERM also asks the
        # native bridge to abort operations and close its source sessions.
        if failed:
            self._terminate()
        with self.close_lock:
            if self.process.poll() is None:
                try:
                    # Idle explicit close keeps graceful EOF. With a writer in
                    # flight, reap the child before closing potentially locked IO.
                    if not failed and self.write_lock.acquire(blocking=False):
                        try:
                            self.process.stdin.close()
                        finally:
                            self.write_lock.release()
                    else:
                        self._terminate()
                    self.process.wait(timeout=5)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    self._terminate()
                    try:
                        self.process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait(timeout=5)
            try:
                self.process.stdin.close()
            except (OSError, ValueError):
                pass

    def close(self):
        self._stop()
        if threading.current_thread() is not self.reader:
            self.reader.join(timeout=2)


class Journal:
    """Persist dispatch before sending. A crashed send is never automatically re-executed."""
    def __init__(self, directory, binding=None):
        path = directory / 'remote-commands.sqlite3'
        if path.is_symlink():
            raise ValueError('Unsafe source command journal.')
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        os.close(fd)
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode):
            raise ValueError('Unsafe source command journal.')
        self.db = sqlite3.connect(path)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS destination (binding TEXT NOT NULL)')
        prior = self.db.execute('SELECT binding FROM destination').fetchone()
        if binding is not None:
            if prior is not None and prior[0] != binding:
                self.db.close()
                raise ValueError('Use a new private source state directory for a different connector destination.')
            if prior is None:
                self.db.execute('INSERT INTO destination(binding) VALUES (?)', (binding,))
        self.db.commit()

    def begin(self, command):
        fingerprint = hashlib.sha256(json.dumps({k: command.get(k) for k in ('type', 'target_id', 'session_key', 'payload')}, sort_keys=True).encode()).hexdigest()
        row = self.db.execute('SELECT fingerprint,result FROM commands WHERE id=?', (command['command_id'],)).fetchone()
        if row:
            if row[0] != fingerprint:
                raise ValueError('A remote command identity was reused with different content.')
            return json.loads(row[1]) if row[1] is not None else {'error': 'Native outcome unknown after an interrupted dispatch; not replayed.'}
        count = self.db.execute('SELECT COUNT(*) FROM commands').fetchone()[0]
        if count >= 100_000:
            raise ValueError('The source command journal is full; retire this connector before creating another.')
        self.db.execute('INSERT INTO commands(id,fingerprint) VALUES (?,?)', (command['command_id'], fingerprint))
        self.db.commit()
        return None

    def finish(self, command_id, result):
        self.db.execute('UPDATE commands SET result=? WHERE id=?', (json.dumps(result), command_id))
        self.db.commit()

    def close(self):
        self.db.close()


def choose(bridge, args, verify=True):
    report = bridge.call({'type': 'discover', 'payload': {'project': str(Path(args.project).expanduser().resolve()), 'runtime': args.runtime}})
    selector = {'kind': args.selector_kind}
    if args.selector_name:
        selector['name'] = args.selector_name
    candidates = [target for target in report['targets'] if target['selector'] == selector]
    if len(candidates) != 1:
        raise ValueError('The chosen native agent/profile was not discovered. Run remote discover and select an exact target.')
    return bridge.call({'type': 'prepare', 'target': candidates[0]})['target'] if verify else candidates[0]


def history_inventory(value):
    if not isinstance(value, str) or len(value) != 64 or any(character not in '0123456789abcdef' for character in value):
        raise ValueError('The source omitted a valid history inventory. Retry remote import-history from the beginning; earlier imports are deduplicated.')
    return value


def history_summary(bridge, target):
    if target['selector']['kind'] != 'project':
        raise ValueError('History belongs to a project and runtime, not a named agent or profile. Select --selector-kind project for history; connect named setups separately for live runs.')
    report = bridge.call({'type': 'history-preview', 'target': target})
    total = report.get('total')
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        raise ValueError('The source returned an invalid history preview.')
    return {'candidate_sessions': total, 'skipped': report.get('skipped', []), 'inventory': history_inventory(report.get('inventory'))}


def approve_history(args, destination, target, preview):
    if args.yes:
        return True
    print(json.dumps({'destination': destination, 'project': target['project'], 'runtime': target['runtime'], 'history': preview}))
    print('Import ended conversation history for only this project and runtime. This does not run a model or enable self-improvement.')
    return input('Import this selected history? [y/N] ').strip().lower() in {'y', 'yes'}


def upload_history(args, state, *, approved_inventory=None):
    if not state.data.get('history_import') or state.data.get('disconnected') or not state.data.get('agent_id'):
        raise ValueError('History import was not enabled for this connection. Create a new connection with --history or --history-only and a matching console enrollment grant.')
    target_id, target = next(iter(state.data['targets'].items()))
    bridge = Bridge(args.bridge or state.data.get('bridge'))
    try:
        if approved_inventory is None:
            preview = history_summary(bridge, target)
            if not approve_history(args, state.data['origin'], target, preview):
                return {'status': 'cancelled'}
            approved_inventory = preview['inventory']
        inventory = history_inventory(approved_inventory)
        cursor, uploaded, imported, already, pages, skipped = 0, 0, 0, 0, 0, []
        while True:
            page = bridge.call({'type': 'history-export', 'target': target, 'payload': {'cursor': cursor, 'inventory': inventory, 'redact_values': [state.data['credential']]}})
            if history_inventory(page.get('inventory')) != inventory:
                raise ValueError('The source history inventory changed during import. Retry remote import-history from the beginning; earlier imports are deduplicated.')
            sessions = page.get('sessions')
            if not isinstance(sessions, list) or len(sessions) > 20:
                raise ValueError('The source returned an invalid history page.')
            body = {'sessions': sessions}
            if len(json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode()) > 2_000_000:
                raise ValueError('The selected history page exceeds the upload limit; no partial session was sent.')
            if sessions:
                receipt = request(state.data['origin'], state.data['credential'], 'POST',
                        f"/v2/connectors/{identifier(state.data['connector_id'])}/targets/{identifier(target_id)}/history", body)
                counts = [receipt.get('imported'), receipt.get('already')]
                if any(not isinstance(count, int) or isinstance(count, bool) or count < 0 for count in counts) or sum(counts) != len(sessions):
                    raise ValueError('The destination did not acknowledge every history session. Retry remote import-history; previously imported sessions are deduplicated.')
                imported += counts[0]
                already += counts[1]
                uploaded += len(sessions)
            skipped.extend(page.get('skipped', []))
            pages += 1
            next_cursor = page.get('next_cursor')
            if next_cursor is None:
                break
            if not isinstance(next_cursor, int) or isinstance(next_cursor, bool) or next_cursor <= cursor or pages >= 100_000:
                raise ValueError('The source returned an invalid history cursor.')
            cursor = next_cursor
        return {'status': 'imported', 'sessions_uploaded': uploaded, 'imported': imported, 'already': already, 'skipped': skipped, 'agent_id': state.data['agent_id']}
    finally:
        bridge.close()


def connect(args, state):
    api_origin = origin(args.origin)
    history = args.history or args.history_only
    sync_only = getattr(args, 'sync_only', False)
    config_sync = not getattr(args, 'no_sync', False)
    native_execution = not (args.history_only or sync_only)
    if sync_only and not config_sync:
        raise ValueError('--sync-only needs setup sync; remove --no-sync.')
    if config_sync:
        print(SYNC_CONSENT, file=sys.stderr)
    if history and args.selector_kind != 'project':
        raise ValueError('History belongs to a project and runtime. Select --selector-kind project for history; connect named agents or profiles separately for live runs.')
    if state.data.get('connector_id') and state.data.get('disconnected'):
        raise ValueError('Use a new private --state-dir for a replacement connection. The old command journal must remain bound to its original destination.')
    pending_import = state.data.get('remote') and state.data.get('connector_id') and not state.data.get('disconnected') and not state.data.get('agent_id')
    if state.data.get('connector_id') and not state.data.get('disconnected') and not pending_import:
        raise ValueError('This source state already has a connection. Use remote import-history to import history again, or use another private state directory for a new connection.')
    if pending_import:
        if state.data['origin'] != api_origin:
            raise ValueError('This pending connection belongs to another destination.')
        if (state.data.get('native_execution', True) != native_execution or state.data.get('history_import', False) != history
                or state.data.get('config_sync', False) != config_sync):
            raise ValueError('Retry the pending connection with the same execution/history/setup-sync choices.')
        target_id, target = next(iter(state.data['targets'].items()))
        selector = {'kind': args.selector_kind, **({'name': args.selector_name} if args.selector_name else {})}
        if target['project'] != str(Path(args.project).expanduser().resolve()) or target['runtime'] != args.runtime or target['selector'] != selector:
            raise ValueError('Retry only the already approved pending source import, or use a separate state directory.')
        if history:
            bridge = Bridge(args.bridge or state.data.get('bridge'))
            try:
                preview = history_summary(bridge, target)
            finally:
                bridge.close()
            if not approve_history(args, api_origin, target, preview):
                return {'status': 'cancelled'}
    else:
        bridge = Bridge(args.bridge)
        try:
            target = choose(bridge, args, verify=native_execution)
            preview = history_summary(bridge, target) if history else None
        finally:
            bridge.close()
        if not args.yes:
            print(json.dumps({'destination': api_origin, 'project': target['project'], 'runtime': target['runtime'], 'selector': target['selector'], 'history': preview}))
            if native_execution:
                print('This connection allows the destination to run this selected agent using its existing native permissions. Run prompts, results, tool activity, usage and standing instruction evidence are sent for those jobs. Native credentials stay on this machine.')
            if history:
                print('Ended conversation history for this project and runtime will be imported. This does not run a model or enable self-improvement.')
            else:
                print('Existing conversation history is not imported.')
            if input('Connect and import this exact setup? [y/N] ').strip().lower() not in {'y', 'yes'}:
                return {'status': 'cancelled'}
        if args.credential_file:
            credential = read_credential(args.credential_file, api_origin)
        elif sys.stdin.isatty():
            credential = getpass.getpass('One-use enrollment token from the destination console: ')
        else:
            raise ValueError('Use a private origin-bound --credential-file, or an interactive terminal for the enrollment token.')
        if not credential or len(credential) > 8192 or '\n' in credential or '\r' in credential:
            raise ValueError('Invalid enrollment credential.')
        operation = state.data.setdefault('remote_registration_operation', str(uuid4()))
        state.save()
        registered = request(api_origin, credential, 'POST', '/v2/connectors', {
            'installation_id': state.data['installation_id'], 'label': args.name,
            'capabilities': {'native_execution': native_execution, 'history_import': history, 'config_sync': config_sync}, 'operation_id': operation,
        })
        connector = registered.get('connector', {})
        if config_sync and connector.get('capabilities', {}).get('config_sync') is not True:
            raise ValueError('The destination did not grant setup sync. Update it or explicitly connect with --no-sync.')
        connector_id = identifier(connector.get('id') or connector.get('connector_id'))
        token = registered.get('credential')
        if not isinstance(token, str) or not token or len(token) > 8192 or '\n' in token or '\r' in token:
            raise ValueError('Invalid connector credential response.')
        target_id = str(uuid4())
        if sync_only:
            target = {**target, 'sync_only': True, 'capabilities': {**target['capabilities'], 'launch': False}}
        state.data.update(origin=api_origin, connector_id=connector_id, credential=token,
                          credential_expires_at=registered.get('credential_expires_at'),
                          remote=True, disconnected=False, targets={target_id: target},
                          native_execution=native_execution, history_import=history,
                          config_sync=config_sync, sync_roots=approved_roots(target) if config_sync else [],
                          bridge=str(Path(args.bridge).resolve()) if args.bridge else None)
        state.data.pop('remote_registration_operation', None)
        state.save()
    cli_adoption = adoption(target, api_origin, state.data['connector_id'], target_id) if config_sync else None
    if sync_only and cli_adoption is None:
        raise ValueError('Enable CLI capture for this exact project and destination first, then retry sync-only connection. An observed session without that verified association is not silently duplicated.')
    imported = request(api_origin, state.data['credential'], 'POST', f"/v2/connectors/{identifier(state.data['connector_id'])}/import", {
        'target_id': target_id, 'name': args.agent_name or Path(target['project']).name,
        'target': target, 'history_only': args.history_only,
        **({'cli_adoption': cli_adoption} if cli_adoption else {}),
    })
    if cli_adoption and imported.get('agent_id') != 'cli-' + cli_adoption['connection_id']:
        raise ValueError('The destination did not preserve the associated CLI agent identity; source import was not accepted locally.')
    state.data['agent_id'] = imported['agent_id']
    state.save()
    result = {'status': 'connected', 'connector_id': state.data['connector_id'], 'agent_id': imported['agent_id'], 'runtime': target['runtime'], 'worker': 'stopped'}
    if history:
        try:
            result['history'] = upload_history(args, state, approved_inventory=preview['inventory'])
        except (ValueError, OSError, APIError) as error:
            raise ValueError(safe_message(error) + ' The setup is connected and its worker is stopped. Resume with remote import-history using the same --state-dir; earlier imports are deduplicated.') from None
    if (native_execution or config_sync) and not args.no_start:
        start(state, args.bridge)
        result['worker'] = 'running'
    return result


def enable_sync(args, state):
    """A fresh owner-issued enrollment is required; the old scoped token cannot upgrade itself."""
    if (not state.data.get('remote') or state.data.get('disconnected') or not state.data.get('credential')
            or not state.data.get('agent_id') or len(state.data.get('targets', {})) != 1):
        raise ValueError('Enable sync only for an existing imported source connection. Its target and agent identity must be retained.')
    api_origin = state.data['origin']
    if args.origin and origin(args.origin) != api_origin:
        raise ValueError('Enable sync uses only the saved destination; use another state directory for another server.')
    # No cooperative idle/stop proof exists for this daemon. Do not rotate its credential while
    # it may own native work. The operating-system lock proves it has fully stopped.
    try:
        held = lock_worker(state)
    except ValueError:
        raise ValueError('Stop the existing source worker through its supervisor after its native jobs finish, then enable sync. No running job was interrupted.') from None
    try:
        print(SYNC_CONSENT, file=sys.stderr)
        if not args.yes and input('Authorize setup sync for this saved source and destination? [y/N] ').strip().lower() not in {'y', 'yes'}:
            return {'status': 'cancelled'}
        if args.credential_file:
            enrollment = read_credential(args.credential_file, api_origin)
        elif sys.stdin.isatty():
            enrollment = getpass.getpass('Fresh one-use enrollment token for this existing connector: ')
        else:
            raise ValueError('Use a private origin-bound --credential-file containing a new owner enrollment for this existing connector.')
        if not enrollment or len(enrollment) > 8192 or '\n' in enrollment or '\r' in enrollment:
            raise ValueError('Invalid enrollment credential.')
        enrollment_hash = hashlib.sha256(enrollment.encode()).hexdigest()
        pending = state.data.get('sync_registration')
        if pending and pending.get('enrollment_hash') != enrollment_hash:
            # An explicitly supplied fresh owner code can recover an expired uncertain registration.
            # Preserve the old receipt, but never reuse its operation or its queued snapshot bytes.
            history = state.data.get('sync_registration_history', [])
            if not isinstance(history, list) or len(history) >= 100:
                raise ValueError('Retained source authorization receipts need review before another enrollment.')
            state.data['sync_registration_history'] = [*history, pending]
            pending = None
        capabilities = {'native_execution': state.data.get('native_execution', True),
                        'history_import': state.data.get('history_import', False), 'config_sync': True}
        if pending is None:
            pending = {'operation_id': str(uuid4()), 'enrollment_hash': enrollment_hash, 'capabilities': capabilities}
            state.data['sync_registration'] = pending
            state.save()
        elif pending.get('capabilities') != capabilities:
            raise ValueError('The pending source authorization belongs to different capabilities; its receipt was preserved.')
        reply = request(api_origin, enrollment, 'POST', '/v2/connectors', {
            'installation_id': state.data['installation_id'], 'label': args.name,
            'capabilities': capabilities, 'operation_id': pending['operation_id'],
        })
        connector = reply.get('connector', {})
        if (connector.get('id', connector.get('connector_id')) != state.data['connector_id']
                or connector.get('capabilities', {}).get('config_sync') is not True):
            raise ValueError('The owner enrollment did not authorize setup sync for this exact existing connector; no source identity was replaced.')
        credential = reply.get('credential')
        if not isinstance(credential, str) or not credential or len(credential) > 8192 or '\n' in credential or '\r' in credential:
            raise ValueError('Invalid connector credential response.')
        target = next(iter(state.data['targets'].values()))
        state.data.update(credential=credential, credential_expires_at=reply.get('credential_expires_at'),
                          config_sync=True, sync_roots=approved_roots(target))
        state.data.pop('sync_registration', None)
        state.save()
    finally:
        os.close(held)
    if not args.no_start:
        start(state, args.bridge)
    return {'status': 'sync_enabled', 'connector_id': state.data['connector_id'], 'agent_id': state.data['agent_id'],
            'worker': 'stopped' if args.no_start else 'running'}


def lock_worker(state, blocking=False):
    fd = os.open(state.directory / 'remote-worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return fd
    except BlockingIOError:
        os.close(fd)
        raise ValueError('The remote worker is already running for this source state.') from None


def running(state):
    try:
        fd = lock_worker(state)
    except ValueError:
        return True
    os.close(fd)
    return False


def start(state, bridge=None):
    if state.data.get('native_execution') is False and state.data.get('config_sync') is not True:
        raise ValueError('This is a history-only connection. Create a new live connection to run an agent.')
    if running(state):
        return
    command = [sys.executable, '-m', 'agentrun_cli', 'remote', 'worker', '--foreground', '--state-dir', str(state.directory)]
    if bridge or state.data.get('bridge'):
        command += ['--bridge', bridge or state.data['bridge']]
    log = os.open(state.directory / 'remote-worker.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    finally:
        os.close(log)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if running(state):
            return
        if child.poll() is not None:
            break
        time.sleep(.05)
    raise ValueError('The source worker did not start; run remote worker --foreground to inspect it.')


def worker(state, bridge_path=None, once=False):
    if state.data.get('native_execution') is False and state.data.get('config_sync') is not True:
        raise ValueError('This is a history-only connection. Create a new live connection to run an agent.')
    if not state.data.get('remote') or state.data.get('disconnected') or not state.data.get('credential'):
        raise ValueError('Connect an explicit source target before starting the remote worker.')
    lock = lock_worker(state)
    journal = Journal(state.directory, json.dumps([state.data['origin'], state.data['connector_id']]))
    incoming = queue.Queue()
    bridge = Bridge(bridge_path or state.data.get('bridge'), incoming.put)
    pool = ThreadPoolExecutor(max_workers=8)
    network = ThreadPoolExecutor(max_workers=8)
    heartbeats = ThreadPoolExecutor(max_workers=1)
    sync_pool = ThreadPoolExecutor(max_workers=1)
    publisher = SourcePublisher(state, lambda path: Bridge(path, max_bytes=SNAPSHOT_BYTES), request) if state.data.get('config_sync') is True else None
    sync_future, next_sync = None, 0
    polling = None
    poll_started = 0
    poll_generation = 0
    worker_id = str(uuid4())
    active = {}
    stopping = threading.Event()
    previous_handlers = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[sig] = signal.signal(sig, lambda *_: stopping.set())
    api_origin, token, connector_id = state.data['origin'], state.data['credential'], identifier(state.data['connector_id'])
    prefix = f'/v2/connectors/{connector_id}'
    targets = state.data.get('targets', {})
    next_poll = 0
    polled = False
    last_poll = time.time()

    def dispatch(command, cancelled):
        target = targets.get(command['target_id'])
        if target is None:
            raise ValueError('The destination requested a source target that was not approved locally.')
        if command['type'] not in {'prepare', 'open', 'send', 'close'}:
            raise ValueError('Unsupported source operation.')
        message = {'id': command['command_id'], 'type': command['type'], 'target': target, 'payload': command.get('payload', {})}
        if command.get('session_key'):
            message['session_key'] = identifier(command['session_key'])
        return bridge.call(message, cancelled=cancelled)

    def receive(command):
        command_id = identifier(command.get('command_id'))
        now, deadline, expires = time.time(), epoch(command['deadline_at']), epoch(command['lease_expires_at'])
        if deadline > now + 610 or expires > now + 40:
            raise ValueError('The destination exceeded the source execution deadline or lease limit.')
        if deadline <= now or expires <= now:
            raise ValueError('The source command expired before dispatch.')
        if command_id in active:
            active[command_id]['expires'] = min(active[command_id]['deadline'], expires)
            return
        identifier(command.get('target_id'))
        lease = command.get('lease_token')
        if not isinstance(lease, str) or not lease or len(lease) > 8192:
            raise ValueError('Invalid source command lease.')
        result = journal.begin(command)
        record = {'command': command, 'expires': epoch(command['lease_expires_at']), 'deadline': epoch(command['deadline_at']), 'events': [], 'pending_batch': None, 'sequence': 0, 'result': result, 'saved': result is not None, 'cancelled': threading.Event()}
        if result is None:
            record['future'] = pool.submit(dispatch, command, record['cancelled'])
        active[command_id] = record

    def stop_source(command_id, record):
        if not record.get('source_cancelled'):
            record['source_cancelled'] = True
            record['cancelled'].set()
            future = record.get('future')
            if future is not None:
                future.cancel()
            delivery = record.get('delivery')
            if delivery is not None:
                delivery.cancel()
            bridge.cancel(command_id)

    def poll():
        nonlocal polled, last_poll, next_poll, polling, poll_started, poll_generation
        now = time.time()
        if polling is None:
            poll_started = now
            poll_generation += 1
            polling = heartbeats.submit(request, api_origin, token, 'POST', prefix + '/poll', {'worker_id': worker_id, 'active': [
                {'command_id': key, 'lease_token': value['command']['lease_token']} for key, value in active.items()
            ]})
            return
        if not polling.done():
            return
        finished, polling = polling, None
        needs_fresh_poll = False
        try:
            reply = finished.result()
            polled = True
            last_poll = time.time()
            if not isinstance(reply.get('cancelled', []), list):
                raise ValueError('Invalid remote cancellation list.')
            for cancelled in reply.get('cancelled', []):
                record = active.pop(cancelled, None)
                if record is not None:
                    stop_source(cancelled, record)
                    # Retire delivery as well as execution. Never replace a result already
                    # persisted for an identical completion retry after a lost reply.
                    if not record['saved']:
                        journal.finish(cancelled, {'error': 'The destination cancelled this native operation.'})
            for record in active.values():
                if record.get('lease_rejected'):
                    # A heartbeat already in flight at rejection may predate cancellation.
                    # It renews neither this source nor its rejected delivery. Require a
                    # later-started heartbeat before treating missing cancellation as fatal.
                    if poll_generation > record['lease_rejected_poll']:
                        # A 412 can also mean a sequence/protocol error. Only an explicit
                        # authenticated cancellation authorizes discarding pending delivery.
                        raise ValueError('The destination rejected the active command lease; execution stopped.')
                    needs_fresh_poll = True
                    continue
                record['expires'] = min(record['deadline'], poll_started + 25)
            commands = reply.get('commands', [])
            if not isinstance(commands, list) or len(commands) > 16:
                raise ValueError('Invalid remote command batch.')
            for command in commands:
                receive(command)
        except APIError as error:
            if 400 <= error.status < 500 and error.status != 429:
                raise ValueError('The destination revoked or rejected this connector; source execution stopped.') from None
        except OSError:
            pass
        next_poll = 0 if needs_fresh_poll else poll_started + 1

    def drain_events():
        while True:
            try:
                event = incoming.get_nowait()
            except queue.Empty:
                break
            for command_id, record in active.items():
                command = record['command']
                if command.get('session_key') == event.get('session_key') and command['type'] == 'send':
                    if record.get('events_rejected'):
                        break
                    native_event = event['event']
                    # Large assistant chunks are losslessly split for the bounded HTTP event envelope.
                    pieces = [native_event]
                    if native_event.get('type') == 'text' and isinstance(native_event.get('text'), str):
                        value = native_event['text']
                        pieces = [{**native_event, 'text': value[offset:offset + 10_000]} for offset in range(0, len(value), 10_000)]
                    pending_events = record['pending_batch']['events'] if record['pending_batch'] is not None else []
                    if any(len(json.dumps(row).encode()) > 200_000 for row in pieces) or sum(len(json.dumps(row).encode()) for row in [*pending_events, *record['events'], *pieces]) > 2_000_000:
                        stop_source(command_id, record)
                        record['result'] = {'error': 'Native event delivery exceeded the bounded source queue; execution stopped.'}
                        record['events'] = []
                    else:
                        record['events'].extend(pieces)
                    break

    try:
        while not stopping.is_set():
            now = time.time()
            if publisher is not None and sync_future is None and now >= next_sync:
                sync_future = sync_pool.submit(publisher.once)
            if sync_future is not None and sync_future.done():
                try:
                    sync_future.result()
                except (ValueError, OSError, APIError):
                    pass  # Its exact private payload remains pending; source execution is independent.
                sync_future, next_sync = None, time.time() + 30
            if state.data.get('native_execution') is not False and (now >= next_poll or polling is not None):
                poll()
            if state.data.get('native_execution') is not False and time.time() - last_poll >= 30:
                raise ValueError('The destination stopped renewing this worker; source sessions were closed.')
            drain_events()
            for command_id, record in list(active.items()):
                if active.get(command_id) is not record:
                    continue
                if min(record['expires'], record['deadline']) <= time.time():
                    stop_source(command_id, record)
                    record['result'] = {'error': 'The remote lease expired; native execution stopped and was not replayed.'}
                    # Losing a source lease ends the worker and closes every native child/session.
                    raise ValueError('The source lease expired; inspect the destination before restarting the worker.')
                if record.get('lease_rejected'):
                    # A failed reconciliation never resumes source execution or uploads;
                    # the original unrenewed lease/deadline still bounds the next poll.
                    continue
                future = record.get('future')
                if future is not None and future.done() and record['result'] is None:
                    # A completed dispatch has already queued every synchronous reader
                    # callback. Drain that final tail before allowing its completion.
                    drain_events()
                    if record['result'] is None:
                        try:
                            record['result'] = {'result': future.result()}
                        except Exception as error:
                            record['result'] = {'error': safe_message(error)}
                try:
                    delivery = record.get('delivery')
                    if delivery is not None:
                        if not delivery.done():
                            continue
                        record['delivery'] = None
                        acknowledgement = delivery.result()
                        if acknowledgement.get('accepted') is not True:
                            raise ValueError('The destination did not acknowledge native delivery; the original payload remains pending.')
                        if record['delivery_kind'] == 'events':
                            record['pending_batch'] = None
                            record['sequence'] += 1
                        else:
                            del active[command_id]
                            continue
                    if record['pending_batch'] is None and record['events']:
                        events, size = [], 0
                        for event in record['events'][:50]:
                            next_size = len(json.dumps(event).encode())
                            if events and size + next_size > 240_000:
                                break
                            events.append(event)
                            size += next_size
                        # Keep this exact payload until acknowledged. Later events wait for the next sequence.
                        record['pending_batch'] = {
                            'lease_token': record['command']['lease_token'], 'sequence': record['sequence'], 'events': events,
                        }
                        del record['events'][:len(events)]
                    if record['pending_batch'] is not None:
                        record['delivery_kind'] = 'events'
                        record['delivery'] = network.submit(request, api_origin, token, 'POST', prefix + f'/commands/{command_id}/events', record['pending_batch'])
                    elif record['result'] is not None and not record['events']:
                        completion = {'lease_token': record['command']['lease_token'], **record['result']}
                        if len(json.dumps(completion, separators=(',', ':'), ensure_ascii=False).encode()) > MAX_BYTES:
                            # A valid bridge frame can exceed the HTTP limit once wrapped in
                            # its lease. Persist a deliverable failure before the first upload.
                            # This also repairs old journal entries that could never pass the
                            # transport's byte check, without re-executing the native operation.
                            record['result'] = {'error': 'Native result exceeded the bounded completion envelope; execution was not replayed.'}
                            record['saved'] = False
                            completion = {'lease_token': record['command']['lease_token'], **record['result']}
                        if not record['saved']:
                            journal.finish(command_id, record['result'])
                            record['saved'] = True
                        record['delivery_kind'] = 'complete'
                        record['delivery'] = network.submit(request, api_origin, token, 'POST', prefix + f'/commands/{command_id}/complete', completion)
                except APIError as error:
                    if error.status == 413 and record['delivery_kind'] == 'events':
                        # A command can exhaust retained event capacity even when every
                        # batch fits. Stop only its source and durably deliver a small
                        # failure; late source output must not replace that outcome.
                        record['events_rejected'] = True
                        stop_source(command_id, record)
                        record['pending_batch'] = None
                        record['events'] = []
                        record['result'] = {'error': 'Native event delivery exceeded the destination capacity; execution stopped and was not replayed.'}
                        journal.finish(command_id, record['result'])
                        record['saved'] = True
                        continue
                    if error.status == 412:
                        stop_source(command_id, record)
                        record['lease_rejected'] = True
                        record['lease_rejected_poll'] = poll_generation
                        poll()
                        continue
                    if 400 <= error.status < 500 and error.status != 429:
                        stop_source(command_id, record)
                        raise ValueError('The destination rejected the active command lease; execution stopped.') from None
                except OSError:
                    pass
            if once and (polled or state.data.get('native_execution') is False) and not active and sync_future is None and (publisher is None or next_sync > 0):
                break
            stopping.wait(.1)
        return {'status': 'stopped', 'connector_id': connector_id}
    finally:
        for command_id, record in active.items():
            stop_source(command_id, record)
        bridge.close()
        pool.shutdown(wait=True, cancel_futures=True)
        network.shutdown(wait=True, cancel_futures=True)
        heartbeats.shutdown(wait=True, cancel_futures=True)
        sync_pool.shutdown(wait=True, cancel_futures=True)
        journal.close()
        os.close(lock)
        for sig, previous in previous_handlers.items():
            signal.signal(sig, previous)


def safe_message(error):
    if isinstance(error, APIError):
        if 300 <= error.status < 400:
            return 'The destination redirected the request; credentials were not forwarded.'
        if error.status in (401, 403):
            return 'The enrollment or connector credential was rejected. Request a fresh enrollment token.'
        return f'The destination refused the connector request (HTTP {error.status}).'
    # Errors from native output are already redacted by the bridge. Transport/OS errors are intentionally generic.
    if isinstance(error, ValueError):
        printable = ''.join(character if ord(character) >= 32 and ord(character) != 127 else ' ' for character in str(error))
        return ' '.join(printable.split())[:4000] or 'The native source operation failed.'
    return 'The source connector could not complete the operation. Check the destination and local runtime.'


def main(argv=None):
    parser = argparse.ArgumentParser(prog='agentrun remote', description='Explicitly connect a source-machine native setup to an OSS AgentRun server.')
    parser.add_argument('action', choices=['discover', 'history-preview', 'connect', 'enable-sync', 'import-history', 'worker', 'status', 'disconnect'])
    parser.add_argument('--state-dir', default=str(Path.home() / '.agentrun-remote'))
    parser.add_argument('--origin')
    parser.add_argument('--project')
    parser.add_argument('--runtime', choices=['claude-code', 'codex'])
    parser.add_argument('--selector-kind', choices=['project', 'agent', 'profile'], default='project')
    parser.add_argument('--selector-name')
    parser.add_argument('--credential-file', help='Private mode-0600 origin-bound JSON containing the one-use enrollment token as api_key')
    parser.add_argument('--bridge', help='Explicit local path to the installed source runtime JSONL bridge; otherwise agentrun-serve remote-bridge')
    parser.add_argument('--name', default='Remote coding agent')
    parser.add_argument('--agent-name')
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--no-start', action='store_true')
    parser.add_argument('--no-sync', action='store_true', help='Do not grant setup/project export for this new connection')
    history_mode = parser.add_mutually_exclusive_group()
    history_mode.add_argument('--history', action='store_true', help='Connect for live runs and explicitly import this project/runtime history')
    history_mode.add_argument('--history-only', action='store_true', help='Import project/runtime history without native execution; setup sync remains enabled unless --no-sync')
    history_mode.add_argument('--sync-only', action='store_true', help='Sync the existing verified CLI profile without enabling remote native execution')
    parser.add_argument('--foreground', action='store_true')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.action in ('discover', 'history-preview', 'connect') and (not args.project or not args.runtime):
            raise ValueError('Choose an explicit --project and --runtime on this source machine.')
        if (args.history or args.history_only or args.sync_only or args.no_sync) and args.action != 'connect':
            raise ValueError('--history, --history-only, --sync-only and --no-sync are connect options. Use history-preview for a dry run, or import-history for an existing connection.')
        if args.action not in ('discover', 'history-preview', 'connect') and (args.project or args.runtime or args.selector_kind != 'project' or args.selector_name):
            raise ValueError('This command uses only the exact source target in --state-dir; do not supply another project or runtime.')
        if (args.selector_kind == 'project') != (args.selector_name is None):
            raise ValueError('Choose an exact --selector-name only for an agent or profile.')
        if args.action in ('discover', 'history-preview'):
            bridge = Bridge(args.bridge)
            try:
                if args.action == 'history-preview':
                    target = choose(bridge, args, verify=False)
                    result = {'project': target['project'], 'runtime': target['runtime'], 'history': history_summary(bridge, target)}
                else:
                    result = bridge.call({'type': 'discover', 'payload': {'project': str(Path(args.project).expanduser().resolve()), 'runtime': args.runtime}})
            finally:
                bridge.close()
        else:
            state = State(args.state_dir)
            if args.action == 'connect':
                with state.connection():
                    result = connect(args, state)
            elif args.action == 'enable-sync':
                with state.connection():
                    result = enable_sync(args, state)
            elif args.action == 'import-history':
                result = upload_history(args, state)
            elif args.action == 'worker':
                if args.foreground or args.once:
                    result = worker(state, args.bridge, args.once)
                else:
                    start(state, args.bridge)
                    result = {'status': 'running'}
            elif args.action == 'status':
                result = {'connected': bool(state.data.get('remote') and not state.data.get('disconnected')), 'worker_running': running(state),
                          'connector_id': state.data.get('connector_id'), 'agent_id': state.data.get('agent_id'), 'origin': state.data.get('origin'), 'native_execution': state.data.get('native_execution', True), 'history_import': state.data.get('history_import', False)}
                result['config_sync'] = state.data.get('config_sync', False)
            else:
                with state.connection():
                    if not state.data.get('connector_id'):
                        result = {'status': 'disconnected'}
                    else:
                        # Stop source export locally even if the destination cannot receive revocation.
                        # Keep the scoped credential only until its revocation has been acknowledged.
                        state.data.update(disconnected=True, config_sync=False)
                        state.save()
                        if state.data.get('credential'):
                            request(state.data['origin'], state.data['credential'], 'DELETE', '/v2/connectors/' + identifier(state.data['connector_id']))
                            state.data.pop('credential', None)
                            state.save()
                        result = {'status': 'disconnected', 'message': 'Source sync is disabled locally and the destination revoked this connector. Pending snapshots remain private.'}
        print(json.dumps(result))
        return 0
    except KeyboardInterrupt:
        return 0
    except (ValueError, OSError, KeyError, TypeError, APIError, subprocess.SubprocessError) as error:
        print(json.dumps({'error': 'remote_connector_failed', 'message': safe_message(error)}))
        return 1
