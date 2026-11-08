"""One error class per way a call can fail, the outcome kinds every client of the server maps to its own idiom (the CLI to
an exit code, the TypeScript client and this one to a class). No message holds the API key, a secret a body carried, or
the server's own message text, which could quote either: a message names the route, the status and the server's error
code."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar, Dict, Literal, Optional, Tuple, Type

if TYPE_CHECKING:
    from ._generated import Run

ServerError = Dict[str, Any]
"""The server's error object ({"code", "message", ...}), with every copy of the API key cut from its values and keys."""

Kind = Literal["refused", "auth", "unsupported", "unreachable", "usage", "late"]


class AgentRunError(Exception):
    """What every error of this client is: `kind` says which outcome it is."""

    kind: ClassVar[Kind]

    def __init__(self, message: str) -> None:
        super().__init__(message)

    def __reduce__(self) -> Tuple[Any, ...]:
        # Rebuilt from its message and fields, not by calling its constructor again with the message alone.
        return (_restore, (type(self), str(self), dict(self.__dict__)))


def _restore(kind: Type[AgentRunError], message: str, fields: Dict[str, Any]) -> AgentRunError:
    error = kind.__new__(kind)
    Exception.__init__(error, message)
    error.__dict__.update(fields)
    return error


class AgentRunRefused(AgentRunError):
    """The server answered and refused: a 4xx or 5xx other than 401, 403 and 501; a redirect it would take the key
    along to follow (`code` "redirect"); or an answer this client cannot read (`code` "bad_answer")."""

    kind: ClassVar[Kind] = "refused"

    def __init__(self, route: str, status: int, code: Optional[str], error: Optional[ServerError], why: Optional[str] = None, retry_after: Optional[float] = None) -> None:
        super().__init__(why or f"The server refused {route}: {status}{f' {code}' if code else ''}.")
        self.status = status
        self.code = code
        self.error = error
        self.retry_after = retry_after
        """How long the server asked to be left before the same request again (its Retry-After), in seconds."""


AuthReason = Literal["no_token", "bad_header", "refused"]


class AgentRunAuthError(AgentRunError):
    """No API key, one that is not a valid header value (refused before any request), or one the server refused (401,
    403)."""

    kind: ClassVar[Kind] = "auth"

    def __init__(self, reason: AuthReason, message: str, status: Optional[int] = None, code: Optional[str] = None, error: Optional[ServerError] = None) -> None:
        super().__init__(message)
        self.reason: AuthReason = reason
        self.status = status
        self.code = code
        self.error = error


class AgentRunUnsupported(AgentRunError):
    """The server does not offer this operation here (501 unsupported_here); `capability` names what is off."""

    kind: ClassVar[Kind] = "unsupported"
    by: ClassVar[Literal["server"]] = "server"

    def __init__(self, route: str, status: int, code: Optional[str], error: Optional[ServerError]) -> None:
        capability = error.get("capability") if error else None
        self.capability: Optional[str] = capability if isinstance(capability, str) else None
        super().__init__(f"The server does not offer {route} here{f' ({self.capability} is off)' if self.capability else ''}.")
        self.status = status
        self.code = code
        self.error = error


class AgentRunUnreachable(AgentRunError):
    """The server could not be reached, or stopped answering. `cause` is the failure's code (ECONNREFUSED, timeout),
    never its message, which can quote a header."""

    kind: ClassVar[Kind] = "unreachable"

    def __init__(self, base_url: str, cause: str) -> None:
        super().__init__(f"Cannot reach the server at {base_url} ({cause}).")
        self.cause = cause


class AgentRunUsage(AgentRunError):
    """The call was wrong before anything was sent: a bad argument, base URL or option."""

    kind: ClassVar[Kind] = "usage"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class AgentRunTimeout(AgentRunError):
    """runs.wait passed its timeout; the run goes on. `run` is the run as last read, when it was."""

    kind: ClassVar[Kind] = "late"

    def __init__(self, run_id: str, timeout: float, run: Optional[Run]) -> None:
        super().__init__(f"Run {run_id} did not end or wait on a person within {timeout:g} s; it goes on.")
        self.run_id = run_id
        self.run = run
