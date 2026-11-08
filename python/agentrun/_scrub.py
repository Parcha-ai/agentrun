"""Cutting secrets from what the server answers: the API key from an error object, and a secret body's values from the
answer to it. Always from a JSON value's strings and keys, never from its text, so what is left is still the same JSON
with its structure and every other value kept. As packages/client/src/scrub.ts, form for form."""

from __future__ import annotations

import json
from typing import Any, Callable, Iterable, List, Sequence, TypeVar
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

    def value(node: Any) -> Any:
        if isinstance(node, str):
            return text(node)
        if isinstance(node, list):
            return [value(child) for child in node]  # pyright: ignore[reportUnknownVariableType]
        if isinstance(node, dict):
            out: dict[str, Any] = {}
            for key, child in node.items():  # pyright: ignore[reportUnknownVariableType]
                name = cut = text(str(key))  # pyright: ignore[reportUnknownArgumentType]
                n = 2
                while name in out:
                    name = f"{cut} ({n})"
                    n += 1
                out[name] = value(child)
            return out
        return node

    def scrub(node: T) -> T:
        return value(node) if forms else node

    return scrub


def secrets_of(body: str, public_fields: Sequence[str]) -> List[str]:
    """The string values of a secret body, but for its public fields (full paths such as `auth.type`, or `scopes.[]`
    for each item of a list, as the CLI reads them): the secrets to cut. A value under a map is never public, whatever
    its key. A body that is not JSON is one secret whole."""
    try:
        parsed = json.loads(body)
    except ValueError:
        return [body]
    open_ = {tuple(field.split(".")) for field in public_fields}
    found: List[str] = []

    def walk(node: Any, path: tuple[str, ...]) -> None:
        if isinstance(node, str):
            if path not in open_:
                found.append(node)
        elif isinstance(node, list):
            for child in node:  # pyright: ignore[reportUnknownVariableType]
                walk(child, (*path, "[]"))
        elif isinstance(node, dict):
            for key, child in node.items():  # pyright: ignore[reportUnknownVariableType]
                walk(child, (*path, str(key)))  # pyright: ignore[reportUnknownArgumentType]

    walk(parsed, ())
    return found
