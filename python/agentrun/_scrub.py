"""Cutting secrets from what the server answers: the API key from an error object, and a secret body's values from the
answer to it. Always from a JSON value's strings and keys, never from its text, so what is left is still the same JSON
with its structure and every other value kept. As packages/client/src/scrub.ts, form for form."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, Iterable, List, Sequence, Tuple, TypeVar, cast
from urllib.parse import quote

T = TypeVar("T")

HIDDEN = "[hidden]"
# What encodeURIComponent leaves as it is.
URI_COMPONENT_SAFE = "-_.!~*'()"


def forms_of(secret: str) -> List[str]:
    """The forms a server could quote a secret in: as it is, JSON-escaped (as JavaScript and as Python write it) and
    URL-encoded."""
    forms = [secret, json.dumps(secret, ensure_ascii=False)[1:-1], json.dumps(secret)[1:-1]]
    try:
        forms.append(quote(secret, safe=URI_COMPONENT_SAFE))
    except UnicodeEncodeError:
        pass
    return list(dict.fromkeys(forms))


def scrubber_of(secrets: Iterable[str]) -> Callable[[T], T]:
    """Cuts every copy of each secret, in any of its forms, longest first, from a JSON value's strings and keys. Two
    keys the cut makes one are kept apart."""
    forms = sorted({form for secret in secrets if secret for form in forms_of(secret)}, key=len, reverse=True)

    def text(string: str) -> str:
        for form in forms:
            string = string.replace(form, HIDDEN)
        return string

    def value(root: Any) -> Any:
        # A walk with a stack of its own, not recursion: a value nested as deep as the parser reads is cut, never a
        # RecursionError. Each container is copied empty when it is met and filled when it comes off the stack.
        pending: List[Tuple[Any, Any]] = []

        def copy(node: Any) -> Any:
            if isinstance(node, str):
                return text(node)
            if isinstance(node, (list, dict)):
                out: Any = [] if isinstance(node, list) else {}
                pending.append((cast(Any, node), out))
                return out
            return node

        top = copy(root)
        while pending:
            node, out = pending.pop()
            if isinstance(node, list):
                for child in cast(List[Any], node):
                    out.append(copy(child))
                continue
            for key, child in cast(Dict[Any, Any], node).items():
                name = cut = text(str(key))
                n = 2
                while name in out:
                    name = f"{cut} ({n})"
                    n += 1
                out[name] = copy(child)
        return top

    def scrub(node: T) -> T:
        return value(node) if forms else node

    return scrub


def secrets_of(body: str, public_fields: Sequence[str]) -> List[str]:
    """The string values of a secret body, but for its public fields (full paths such as `auth.type`, or `scopes.[]`
    for each item of a list, as the CLI reads them): the secrets to cut. A value under a map is never public, whatever
    its key. A body that is not JSON is one secret whole."""
    try:
        parsed = json.loads(body)
    except (ValueError, RecursionError):  # not JSON, or nested past the parser's depth: one secret whole
        return [body]
    open_ = {tuple(field.split(".")) for field in public_fields}
    found: List[str] = []
    # A walk with a stack of its own, not recursion, in the body's order: any depth the parser read is walked.
    pending: List[Tuple[Any, Tuple[str, ...]]] = [(parsed, ())]
    while pending:
        node, path = pending.pop()
        if isinstance(node, str):
            if path not in open_:
                found.append(node)
        elif isinstance(node, list):
            pending.extend(reversed([(child, (*path, "[]")) for child in cast(List[Any], node)]))
        elif isinstance(node, dict):
            pending.extend(reversed([(child, (*path, str(key))) for key, child in cast(Dict[Any, Any], node).items()]))
    return found
