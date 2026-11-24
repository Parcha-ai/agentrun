"""Bounded, local-only Codex counter reads. No conversation fields leave this boundary.

Existing lifetime totals establish a baseline; only later cumulative increments are
reported. A missed tail, replacement or reset establishes another baseline, never
invents usage for a gap. Checkpoints are committed with delivery by Queue.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import time

MAX_READ_BYTES = 1024 * 1024
MAX_COUNTER = (1 << 53) - 1
COUNTERS = {'input_tokens': 'input_tokens', 'output_tokens': 'output_tokens',
            'cached_input_tokens': 'cache_read_tokens', 'cache_write_input_tokens': 'cache_write_tokens'}


def valid_model(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}', value))


def counter_record(record):
    if record.get('type') != 'event_msg': return None
    payload = record.get('payload')
    if not isinstance(payload, dict) or payload.get('type') != 'token_count': return None
    info = payload.get('info')
    raw = info.get('total_token_usage') if isinstance(info, dict) else None
    if not isinstance(raw, dict): return None
    counts = {wire: raw[native] for native, wire in COUNTERS.items() if native in raw}
    if any(type(value) is not int or not 0 <= value <= MAX_COUNTER for value in counts.values()): return None
    if not {'input_tokens', 'output_tokens'} <= counts.keys(): return None
    if counts['input_tokens'] + counts['output_tokens'] > MAX_COUNTER: return None
    if counts.get('cache_read_tokens', 0) + counts.get('cache_write_tokens', 0) > counts['input_tokens']: return None
    timestamp = record.get('timestamp')
    try:
        if not isinstance(timestamp, str) or len(timestamp) > 40: return None
        parsed = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        if parsed.tzinfo is None or parsed.timestamp() > time.time() + 300: return None
        timestamp = parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError: return None
    return timestamp, counts


def read_usage(candidate, previous=None):
    """Return a metadata checkpoint and source-dated deltas, bounded to 1 MiB/session.

    Both the native ID and a regular user-owned file under CODEX_HOME/sessions
    must match. The public candidate, checkpoint and events never contain records.
    """
    path_value, native = getattr(candidate, 'usage_path', None), getattr(candidate, 'native_id', None)
    if not isinstance(path_value, str) or not native: return previous, []
    try:
        root = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))).resolve()
        path = Path(path_value)
        if path.is_symlink() or not path.resolve().is_relative_to(root / 'sessions'): return previous, []
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid(): return previous, []
            same = bool(previous and previous.get('device') == info.st_dev and previous.get('inode') == info.st_ino and previous.get('native') == native)
            if not same:
                first = file.readline(MAX_READ_BYTES + 1)
                if len(first) > MAX_READ_BYTES: return previous, []
                metadata = json.loads(first)
                if not isinstance(metadata, dict) or metadata.get('type') != 'session_meta' or not isinstance(metadata.get('payload'), dict) or metadata['payload'].get('id') != native: return previous, []
            offset = previous.get('offset', 0) if same else 0
            continuous = same and 0 <= offset <= info.st_size and info.st_size - offset <= MAX_READ_BYTES
            start = offset if continuous else max(0, info.st_size - MAX_READ_BYTES)
            file.seek(start); data = file.read(MAX_READ_BYTES)
            end = data.rfind(b'\n')
            if end < 0: return previous, []
            complete = data[:end + 1]
            if not continuous and start:
                complete = complete[complete.find(b'\n') + 1:]
            state = {'native': native, 'device': info.st_dev, 'inode': info.st_ino, 'offset': start + end + 1,
                     'model': previous.get('model') if continuous else getattr(candidate, 'model', None),
                     'counts': previous.get('counts') if continuous else None,
                     'timestamp': previous.get('timestamp') if continuous else None}
            events = []
            for line in complete.splitlines():
                # Large tool results are ignored before JSON decoding. Native counter
                # and turn-context metadata records are well below this limit.
                if len(line) > 65536: continue
                try: record = json.loads(line)
                except (ValueError, UnicodeError): continue
                if not isinstance(record, dict): continue
                if record.get('type') == 'turn_context':
                    payload = record.get('payload'); model = payload.get('model') if isinstance(payload, dict) else None
                    if valid_model(model): state['model'] = model
                found = counter_record(record)
                if found is None: continue
                timestamp, counts = found
                if state['timestamp'] is not None and datetime.fromisoformat(timestamp.replace('Z', '+00:00')) < datetime.fromisoformat(state['timestamp'].replace('Z', '+00:00')):
                    continue
                prior = state['counts']
                if continuous and prior is not None and valid_model(state['model']):
                    common = counts.keys() & prior.keys()
                    monotonic = all(counts[key] >= prior[key] for key in common)
                    timely = state['timestamp'] is None or datetime.fromisoformat(timestamp.replace('Z', '+00:00')) >= datetime.fromisoformat(state['timestamp'].replace('Z', '+00:00'))
                    if monotonic and timely:
                        delta = {key: counts[key] - prior[key] for key in common}
                        if delta.get('input_tokens', 0) + delta.get('output_tokens', 0) > 0 and delta.get('cache_read_tokens', 0) + delta.get('cache_write_tokens', 0) <= delta['input_tokens']:
                            events.append({'occurred_at': timestamp, 'usage': {'model': state['model'], **delta}})
                state['counts'], state['timestamp'] = counts, timestamp
            if state['counts'] is None and not continuous and start == 0:
                # A complete newly enrolled file with no usage genuinely starts at
                # zero. A partial tail cannot establish this baseline.
                state['counts'] = {key: 0 for key in COUNTERS.values()}
            return state, events
    except (OSError, ValueError, TypeError, OverflowError):
        return previous, []
