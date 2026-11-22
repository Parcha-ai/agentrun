"""Bounded native metadata labels; never derive names from conversation text."""

from pathlib import PurePosixPath, PureWindowsPath
import re
import unicodedata


_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
# Match JavaScript's ASCII word boundaries but Unicode whitespace in Bearer labels.
_SECRET = re.compile(r"\bsk[-_]|ghp_|github_pat_|xox[baprs]-|\bBearer[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|AKIA[A-Z0-9]{12,}", re.IGNORECASE | re.ASCII)
_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://", re.IGNORECASE | re.ASCII)
_PATH = re.compile(r'''(?:^|[\s"'=(])(?:/\S|~[/\\]|[A-Za-z]:[/\\]|\\\\)''')


def label(value, *, project=False):
    """Return safe metadata, truncated without splitting a UTF-16 surrogate pair."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if (not value or _CONTROL.search(value) or
            any(unicodedata.category(char) in {"Cf", "Cs"} for char in value) or
            _SECRET.search(value) or _URL.search(value) or "\\" in value or
            ("/" in value if project else _PATH.search(value))):
        return None
    limit = 80 if project else 120
    units = 0
    for index, char in enumerate(value):
        units += 2 if ord(char) > 0xffff else 1
        if units > limit:
            return value[:index].rstrip() or None
    return value


def native_labels(row, harness, identity, cwd):
    # cwd and task paths are local inputs only; only their last component may leave.
    path = PureWindowsPath(cwd) if "\\" in cwd else PurePosixPath(cwd)
    project = label(path.name, project=True)
    name = label(row.get("name")) or label(row.get("title"))
    nickname = label(row.get("agentNickname"))
    if not name:
        source = row.get("source")
        subagent = source.get("subAgent") if isinstance(source, dict) else None
        spawn = subagent.get("thread_spawn") if isinstance(subagent, dict) else None
        task_path = spawn.get("agent_path") if isinstance(spawn, dict) else None
        if isinstance(task_path, str):
            task = label(PurePosixPath(task_path).name)
            if task:
                task = task.replace("_", " ").replace("-", " ")
                task = task[0].upper() + task[1:]
                name = label(task + (" · " + nickname if nickname else ""))
        if not name and nickname:
            role = label(row.get("agentRole"))
            name = label(nickname + (" · " + role if role else ""))
    if not name:
        name = " · ".join(part for part in (
            "Codex" if harness == "codex" else "Claude Code", project, identity[-8:]) if part)
    return name, project
