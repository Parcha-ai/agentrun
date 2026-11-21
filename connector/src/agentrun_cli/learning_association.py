"""Read source-owned learning receipts; never install hooks or import conversations."""

from dataclasses import dataclass, field
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit


MAX_CONFIG_BYTES = 64 * 1024
MAX_ANCESTORS = 32


def _reject_constant(_value):
    raise ValueError('unsafe_learning_metadata')


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _version_one(value):
    return type(value) in (int, float) and value == 1


@dataclass(frozen=True)
class LearningAssociation:
    readiness: str
    connection_id: str | None = None
    native_session_hash: str | None = None
    runtime: str | None = None
    credential: str | None = field(default=None, repr=False)

    def signature(self):
        # Token rotation changes the checkpoint without persisting the credential.
        return [self.readiness, self.connection_id, self.native_session_hash,
                hashlib.sha256(self.credential.encode()).hexdigest() if self.credential else None]

    def metadata(self, connector_id, source_id, external_session_id, sequence):
        result = {'readiness': self.readiness}
        if self.credential and self.connection_id and self.native_session_hash and connector_id:
            message = json.dumps(['agentrun-cli-learning-observation-v1', connector_id, source_id,
                                  external_session_id, self.runtime, self.connection_id, self.readiness,
                                  self.native_session_hash, sequence], ensure_ascii=False, separators=(',', ':'))
            result.update(connection_id=self.connection_id, native_session_hash=self.native_session_hash,
                          proof=hmac.new(self.credential.encode(), message.encode(), hashlib.sha256).hexdigest())
        return result


def session_role(harness, row):
    source = row.get('source')
    if (isinstance(source, dict) and 'subAgent' in source) or (isinstance(source, str) and source.startswith('subAgent')):
        return 'delegated'
    if any(row.get(key) for key in ('agent_id', 'agentId', 'parentSessionId', 'parent_session_id', 'isSidechain')):
        return 'delegated'
    if harness == 'claude' or source in ('cli', 'vscode', 'exec', 'appServer'):
        return 'root'
    return 'unknown'


def _origin(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or
                parsed.path not in {'', '/'} or parsed.query or parsed.fragment):
            return None
        return parsed.scheme.lower(), parsed.hostname.lower(), parsed.port if parsed.port is not None else (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return None


def _text(path, *, private=False):
    # Config can be absent or unreadable; those are different readiness states.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CONFIG_BYTES or
                info.st_uid != os.getuid() or (private and stat.S_IMODE(info.st_mode) & 0o077)):
            raise ValueError('unsafe_learning_metadata')
        raw = handle.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise ValueError('unsafe_learning_metadata')
        return raw.decode('utf-8')


def _json(path, *, private=False):
    value = json.loads(_text(path, private=private), parse_constant=_reject_constant)
    if not isinstance(value, dict):
        raise ValueError('unsafe_learning_metadata')
    return value


def _no_symlinks(paths):
    for path in paths:
        if path.is_symlink():
            raise ValueError('unsafe_learning_metadata')


def _git_pointer(path, prefix=''):
    value = _text(path).strip()
    target_value = value[len(prefix):].strip()
    if not value.startswith(prefix) or not target_value or any(c in target_value for c in '\0\r\n'):
        raise ValueError('unsafe_learning_metadata')
    target = Path(target_value)
    return target if target.is_absolute() else path.parent / target


def _codex_hook_location(project):
    """Match Codex's reciprocal worktree ownership checks before using shared hooks."""
    for depth, directory in enumerate([project, *project.parents]):
        if depth >= MAX_ANCESTORS:
            raise ValueError('unsafe_learning_metadata')
        marker = directory / '.git'
        _no_symlinks([marker])
        try:
            info = marker.stat()
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(info.st_mode):
            return directory, project
        gitdir = _git_pointer(marker, 'gitdir:')
        _no_symlinks([gitdir])
        gitdir = gitdir.resolve(strict=True)
        if not gitdir.is_dir():
            raise ValueError('unsafe_learning_metadata')
        common_file = gitdir / 'commondir'
        backlink_file = gitdir / 'gitdir'
        _no_symlinks([common_file, backlink_file])
        try:
            common_dir = _git_pointer(common_file)
        except FileNotFoundError:
            return directory, project  # Submodules do not redirect hook discovery.
        backlink = _git_pointer(backlink_file)
        _no_symlinks([common_dir, backlink])
        common_dir = common_dir.resolve(strict=True)
        if (gitdir.parent.name != 'worktrees' or common_dir != gitdir.parent.parent or not common_dir.is_dir()
                or backlink.name != '.git' or backlink.parent.resolve(strict=True) != directory):
            raise ValueError('unsafe_learning_metadata')
        main_root = common_dir.parent
        main_marker = main_root / '.git'
        _no_symlinks([main_root, main_marker])
        main_gitdir = main_marker if main_marker.is_dir() else _git_pointer(main_marker, 'gitdir:')
        _no_symlinks([main_gitdir])
        if main_gitdir.resolve(strict=True) != common_dir:
            raise ValueError('unsafe_learning_metadata')
        config_root = main_root / project.relative_to(directory)
        component = main_root
        for part in project.relative_to(directory).parts:
            component /= part
            _no_symlinks([component])
            if component.exists() and not component.is_dir():
                raise ValueError('unsafe_learning_metadata')
        return directory, config_root
    return None, project


def _codex_hook_project(project):
    return _codex_hook_location(project)[1]


def _project(project, runtime, origin):
    receipt_dir = project / '.agentrun' / 'cli-learning'
    receipt_path = receipt_dir / (runtime + '.json')
    _no_symlinks([project / '.agentrun', receipt_dir, receipt_path])
    try:
        receipt = _json(receipt_path)
    except FileNotFoundError:
        return None
    shared_receipt = (type(receipt.get('version')) in (int, float) and receipt['version'] == 2
                      and runtime == 'codex' and receipt.get('format') == 'codex-shared-json')
    if (not (_version_one(receipt.get('version')) or shared_receipt) or receipt.get('runtime') != runtime or receipt.get('project') != str(project)
            or _origin(receipt.get('url')) != origin):
        raise ValueError('unmatched_learning_receipt')
    hook_project = _codex_hook_project(project) if runtime == 'codex' else project
    if shared_receipt and (hook_project == project or receipt.get('configRoot') != str(hook_project)):
        raise ValueError('unmatched_learning_receipt')
    data_value = receipt.get('dataDir')
    if not isinstance(data_value, str) or not Path(data_value).is_absolute():
        raise ValueError('unsafe_learning_metadata')
    data = Path(data_value).resolve(strict=True)
    if data == project or project in data.parents:
        raise ValueError('unsafe_learning_metadata')
    connection_dir = data / 'cli-learning' / 'connections'
    connection_path = connection_dir / (hashlib.sha256((runtime + '\0' + str(project)).encode()).hexdigest() + '.json')
    _no_symlinks([data / 'cli-learning', connection_dir, connection_path])
    connection = _json(connection_path, private=True)
    if (not _version_one(connection.get('version')) or connection.get('runtime') != runtime or connection.get('project') != str(project)
            or _origin(connection.get('url')) != origin
            or not isinstance(connection.get('connection_id'), str) or not re.fullmatch(r'[a-f0-9]{32}', connection['connection_id'])
            or not isinstance(connection.get('token'), str) or not re.fullmatch(r'ar_cli_[A-Za-z0-9_-]{43}', connection['token'])):
        raise ValueError('unmatched_learning_connection')
    if connection.get('revocation_pending') is True:
        # Capture stops before hook removal and remote revocation finish. The
        # retained credential may only revoke; intact hooks cannot prove readiness.
        raise ValueError('learning_revocation_pending')
    events = ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'] if runtime == 'codex' else ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']
    handlers = receipt.get('handlers')
    if (not isinstance(handlers, dict) or set(handlers) != set(events) or
            any(not isinstance(handler, dict) or handler.get('type') != 'command' or not isinstance(handler.get('command'), str)
                or not _finite_number(handler.get('timeout')) for handler in handlers.values())):
        raise ValueError('unsafe_learning_metadata')
    if shared_receipt:
        if (type(receipt.get('hadHooks')) is not bool or not isinstance(receipt.get('createdEvents'), list)
                or any(not isinstance(event, str) or event not in events for event in receipt['createdEvents'])):
            raise ValueError('unsafe_learning_metadata')
        if 'legacy' in receipt:
            legacy = receipt['legacy']
            if (not isinstance(legacy, dict) or not _version_one(legacy.get('version'))
                    or any(legacy.get(key) != receipt.get(key) for key in ('runtime', 'project', 'dataDir', 'url', 'handlers'))
                    or type(legacy.get('hadHooks')) is not bool or not isinstance(legacy.get('createdEvents'), list)
                    or any(not isinstance(event, str) or event not in events for event in legacy['createdEvents'])):
                raise ValueError('unmatched_learning_receipt')
    scope = (hook_project if shared_receipt else project) / ('.codex' if runtime == 'codex' else '.claude')
    config_path = scope / ('hooks.json' if runtime == 'codex' else 'settings.local.json')
    local_scope = project / ('.codex' if runtime == 'codex' else '.claude')
    _no_symlinks([local_scope, scope, config_path])
    try:
        config = _json(config_path)
    except FileNotFoundError:
        config = {}
    hooks = config.get('hooks', {})
    if not isinstance(hooks, dict):
        raise ValueError('unsafe_learning_metadata')
    configured = config.get('disableAllHooks') is not True and (not shared_receipt or local_scope.is_dir())
    for event in events:
        groups = hooks.get(event, [])
        if not isinstance(groups, list):
            raise ValueError('unsafe_learning_metadata')
        configured = configured and any(isinstance(group, dict) and group.get('matcher', '') in {'', '*'}
                                       and isinstance(group.get('hooks'), list)
                                       and any(isinstance(handler, dict) and _finite_number(handler.get('timeout'))
                                               and handler == handlers[event] for handler in group['hooks']) for group in groups)
    if runtime == 'codex' and not shared_receipt and hook_project != project:
        configured = False
    return ('ready' if configured else 'setup_required', connection['connection_id'], connection['token'])


def discover_learning(candidate, receiver_origin, cache=None):
    """Bounded exact-project matching. Cache only lives for one observation pass."""
    role = getattr(candidate, 'session_role', 'unknown')
    if role == 'delegated':
        return LearningAssociation('unsupported')
    if role != 'root' or not getattr(candidate, 'native_id', None):
        return LearningAssociation('unknown')
    cache = cache if cache is not None else {}
    try:
        cwd = getattr(candidate, 'project_path', None)
        if not isinstance(cwd, str) or not Path(cwd).is_absolute():
            return LearningAssociation('unknown')
        project = Path(cwd).resolve(strict=True)
        if not project.is_dir():
            return LearningAssociation('unknown')
        runtime = 'codex' if candidate.harness == 'codex' else 'claude-code'
        origin = _origin(receiver_origin)
        if origin is None:
            return LearningAssociation('unknown')
        checkout_root = _codex_hook_location(project)[0] if runtime == 'codex' else None
        for depth, directory in enumerate([project, *project.parents]):
            if depth >= MAX_ANCESTORS:
                return LearningAssociation('unknown')
            key = (str(directory), runtime, origin)
            if key not in cache:
                try:
                    cache[key] = _project(directory, runtime, origin)
                except (OSError, ValueError, TypeError, RecursionError):
                    cache[key] = False
            found = cache[key]
            if found is False:
                return LearningAssociation('unknown')
            if found is not None:
                readiness, connection_id, credential = found
                return LearningAssociation(readiness, connection_id, hashlib.sha256(candidate.native_id.encode()).hexdigest(), runtime, credential)
            if directory == checkout_root:
                break  # A separate nested checkout cannot inherit its ancestor's enrollment.
        return LearningAssociation('setup_required')
    except (OSError, ValueError, TypeError, RecursionError):
        return LearningAssociation('unknown')
