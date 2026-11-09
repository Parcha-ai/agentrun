"""What the generated operations (_generated.py) and the hand-written runtime share."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Literal, Mapping, Optional, Protocol, Tuple, TypeVar, Union

T = TypeVar("T")

AnswerKind = Literal["none", "json", "text", "bytes", "json+text", "json+bytes", "text+bytes", "json+text+bytes"]
"""What an operation answers, by its media types: JSON, text, bytes, a mix decided by the answer's type, or nothing."""

RawBody = Union[bytes, bytearray, memoryview, str]
"""A body sent as it is, not as JSON."""


@dataclass(frozen=True)
class Tagged(Generic[T]):
    """An answer and its version, the response's ETag: a later write's If-Match."""

    body: T
    etag: Optional[str]


@dataclass(frozen=True)
class OperationBody:
    required: bool
    types: Tuple[str, ...]


@dataclass(frozen=True)
class Operation:
    """One operation, as the runtime sends it."""

    method: Literal["GET", "PUT", "POST", "PATCH", "DELETE"]
    path: str
    path_params: Tuple[str, ...]
    multi_segment: Tuple[str, ...]
    """The path parameters that are file paths: their slashes are kept. Every other one is encoded whole."""
    query: Tuple[str, ...]
    headers: Tuple[str, ...]
    body: Optional[OperationBody]
    answer: AnswerKind
    secret: bool
    """The body carries secrets: each copy is cut from the answer, and a refusal keeps only its code."""
    public_fields: Tuple[str, ...]
    """A secret body's string fields that are no secret, by their full path."""
    tagged: bool
    """The answer carries an ETag: it comes back as Tagged(body, etag)."""


class Call(Protocol):
    """How a generated method sends its operation."""

    def __call__(
        self,
        operation_id: str,
        args: Tuple[str, ...],
        body: object,
        params: Optional[Mapping[str, object]],
        *,
        timeout: Optional[float] = None,
        stream: bool = False,
        body_type: Optional[str] = None,
    ) -> Any: ...


class Group:
    """A resource group: its methods send their operations through `call`."""

    def __init__(self, call: Call) -> None:
        self._call = call
