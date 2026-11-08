"""The wire: one try of one request over http.client, with its whole-try deadline, plus what the client and its live
calls (_live.py) share: the request they hand to the client's `send`, backoff, the check of a path argument, and a
failure's code. http.client follows no redirect and reads no proxy from the environment, so the key goes to the base
URL's own origin and nowhere else; the client follows a redirect itself, only where it may."""

from __future__ import annotations

import errno
import http.client
import re
import socket
import ssl
import threading
import time
from dataclasses import dataclass, field
from email.message import Message
from email.utils import parsedate_to_datetime
from typing import Iterator, Mapping, Optional, Sequence, Tuple, Type
from urllib.parse import quote

from ._errors import AgentRunUsage

# A header value http.client sends as it is: no line break or other control character, nothing outside Latin-1.
BAD_HEADER = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\xff]")
BACKOFF = 0.5
MAX_BACKOFF = 30.0
MAX_RETRY_AFTER = 60.0
"""The longest Retry-After waited out, in seconds: past it a GET is not tried again (the call fails rather than hang),
and a stream's reconnect waits this long."""
# What encodeURIComponent leaves as it is.
URI_COMPONENT_SAFE = "-_.!~*'()"
CHUNK = 64 * 1024


class Late(Exception):
    """Raised by `send` once an exchange's deadline passed: never seen by a caller."""


@dataclass
class Exchange:
    """What the client's `send` takes: a request already checked, its path under the base URL."""

    method: str
    path: str
    route: str
    retryable: bool
    headers: Mapping[str, str] = field(default_factory=lambda: {})
    body: Optional[bytes] = None
    timeout: Optional[float] = None
    """How long one try may take, its answer read included, in seconds (default: the client's)."""
    deadline: Optional[float] = None
    """When the whole call must end (a wait's timeout), on time.monotonic(): past it, `send` raises Late."""
    secret: bool = False
    """The body carried a secret: a refusal keeps only its code."""
    secrets: Sequence[str] = ()
    """The secret body's values: cut from a refusal before its code is read, as the API key is."""
    streamed: bool = False
    """The success's body is left to the caller, unread (a stream, a download asked to stream); else it is read whole
    inside the exchange, so a body cut midway is tried again or refused as any dropped connection is."""
    idle: Optional[float] = None
    """For a streamed answer: how long one read may wait on the server, in seconds."""


def backoff(tries: int, floor: float = 0.0) -> float:
    """The wait before try `tries + 1`: doubling up to its cap, and never under the server's own (`floor`)."""
    return max(floor, min(MAX_BACKOFF, BACKOFF * 2 ** (tries - 1)))


def pause(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


def retry_after_of(headers: Message) -> float:
    """Retry-After in seconds (seconds or an HTTP date), 0 when there is none."""
    value = (headers.get("retry-after") or "").strip()
    if not value:
        return 0.0
    if value.isdigit():
        return float(value)
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError, IndexError, OverflowError):
        return 0.0


def segment_of(value: object, name: str, multi_segment: bool) -> str:
    """A path argument checked and encoded: whole, or, for a file path, segment by segment. One that the server would
    read as another route (empty, `.`, `..`, plain or encoded, or an encoded slash in a file path) is refused."""
    if not isinstance(value, str) or value == "":
        raise AgentRunUsage(f"{name} must be a string that is not empty.")
    segments = value.split("/")
    if any(re.sub("%2e", ".", segment, flags=re.IGNORECASE) in (".", "..") for segment in segments):
        raise AgentRunUsage(f"{name} may not hold a . or .. path segment, plain or encoded.")
    try:
        if not multi_segment:
            return quote(value, safe=URI_COMPONENT_SAFE)
        if any(segment == "" or re.search("%2f", segment, re.IGNORECASE) for segment in segments):
            raise AgentRunUsage(f"{name} may not hold an empty segment or an encoded slash.")
        return "/".join(quote(segment, safe=URI_COMPONENT_SAFE) for segment in segments)
    except UnicodeEncodeError:
        raise AgentRunUsage(f"{name} is not text that can be sent: it holds a lone surrogate.") from None


# The causes of a connection that was never made: no server took it. Any other failure took a connection and dropped it.
NOT_CONNECTED = frozenset({"ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "connect_timeout"})
# The causes of a TLS handshake the client refused (a certificate it does not trust, a name it does not match).
UNTRUSTED = re.compile(r"CERT|TLS|SSL|UNABLE_TO_")
_EAI = {getattr(socket, name): name for name in dir(socket) if name.startswith("EAI_") and isinstance(getattr(socket, name), int)}


def cause_of(error: BaseException, connected: bool) -> str:
    """A failure's code, never its message: an OSError's message can quote what it failed on."""
    if isinstance(error, ssl.SSLCertVerificationError):
        return "CERT_" + _code(getattr(error, "reason", None), "VERIFY_FAILED")
    if isinstance(error, ssl.SSLError):
        return "SSL_" + _code(getattr(error, "reason", None), "ERROR")
    if isinstance(error, socket.gaierror):
        name = _EAI.get(error.errno or 0, "EAI_FAIL")
        return "ENOTFOUND" if name in ("EAI_NONAME", "EAI_NODATA") else name
    if isinstance(error, (socket.timeout, TimeoutError)):
        return "timeout" if connected else "connect_timeout"
    number = error.errno if isinstance(error, OSError) else None
    if isinstance(number, int) and number in errno.errorcode:
        return errno.errorcode[number]
    name = type(error).__name__
    return name if re.fullmatch(r"\w+", name) else "unknown"


def _code(value: object, fallback: str) -> str:
    return value if isinstance(value, str) and re.fullmatch(r"[A-Z0-9_]+", value) else fallback


class _Watchdog:
    """Ends a try at its deadline: shuts its socket down, so a read blocked on a silent server returns at once."""

    def __init__(self, seconds: float, connection: http.client.HTTPConnection) -> None:
        self.fired = False
        self._connection = connection
        self._timer = threading.Timer(max(0.0, seconds), self._fire)
        self._timer.daemon = True
        self._timer.start()

    def _fire(self) -> None:
        self.fired = True
        sock = self._connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def cancel(self) -> None:
        self._timer.cancel()


class Response:
    """One answer, its head read: the status, the headers and, once read, the body. It holds its connection until it is
    read whole or closed."""

    def __init__(self, connection: http.client.HTTPConnection, answer: http.client.HTTPResponse, watchdog: _Watchdog) -> None:
        self._connection = connection
        self._answer = answer
        self._watchdog = watchdog
        self.status = answer.status
        self.headers: Message = answer.headers
        self.data: Optional[bytes] = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def timed_out(self) -> bool:
        return self._watchdog.fired

    def read(self) -> bytes:
        """The body, read whole: a body cut midway, or one the try's deadline ended, raises."""
        if self.data is None:
            try:
                data = b"" if self.status in (204, 205, 304) else self._answer.read()
                if self._watchdog.fired:
                    raise socket.timeout("timed out")
            finally:
                self.close()
            self.data = data
        return self.data

    def stream(self, timeout: Optional[float]) -> StreamedResponse:
        """The body left to the caller: the try's deadline is off, and each read waits at most `timeout`."""
        self._watchdog.cancel()
        if self._connection.sock is not None:
            self._connection.sock.settimeout(timeout)
        return StreamedResponse(self._connection, self._answer)

    def close(self) -> None:
        self._watchdog.cancel()
        self._answer.close()
        self._connection.close()


class StreamedResponse:
    """A download's answer with its body unread, as `stream=True` gives it: read it, or iterate it in chunks, then close
    it (or use it as a context manager). Each read waits at most the call's timeout."""

    def __init__(self, connection: http.client.HTTPConnection, answer: http.client.HTTPResponse) -> None:
        self._connection = connection
        self._answer = answer
        self.status: int = answer.status
        self.headers: Message = answer.headers

    def read(self, size: int = -1) -> bytes:
        """Up to `size` bytes of the body, or the rest of it."""
        return self._answer.read() if size < 0 else self._answer.read(size)

    def read1(self, size: int = CHUNK) -> bytes:
        """What the next read of the connection gives, at most `size` bytes; b"" at the end."""
        return self._answer.read1(size)

    def iter_bytes(self, chunk_size: int = CHUNK) -> Iterator[bytes]:
        """The body in chunks of at most `chunk_size` bytes, as they come."""
        while True:
            chunk = self._answer.read1(chunk_size)
            if not chunk:
                return
            yield chunk

    def close(self) -> None:
        self._answer.close()
        self._connection.close()

    def __enter__(self) -> StreamedResponse:
        return self

    def __exit__(self, kind: Optional[Type[BaseException]], value: Optional[BaseException], trace: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"StreamedResponse(status={self.status})"


@dataclass(frozen=True)
class Origin:
    """Where requests go: scheme, host and port, as http.client connects to them."""

    scheme: str
    host: str
    port: int

    def connect(self, timeout: float, context: Optional[ssl.SSLContext]) -> http.client.HTTPConnection:
        if self.scheme == "https":
            return http.client.HTTPSConnection(self.host, self.port, timeout=timeout, context=context)
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)


class Failure(Exception):
    """A try that failed on the wire: its failure's code, and whether a connection was made."""

    def __init__(self, cause: str, connected: bool, late: bool) -> None:
        super().__init__(cause)
        self.cause = cause
        self.connected = connected
        self.late = late


def attempt(origin: Origin, method: str, target: str, headers: Sequence[Tuple[str, str]], body: Optional[bytes], seconds: float, context: Optional[ssl.SSLContext]) -> Response:
    """One request on a connection of its own, ended at `seconds` from now: its answer with the head read, or Failure."""
    connection = origin.connect(max(seconds, 0.001), context)
    watchdog = _Watchdog(seconds, connection)
    connected = False
    try:
        connection.connect()
        connected = True
        connection.putrequest(method, target)
        for name, value in headers:
            connection.putheader(name, value)
        if body is not None or method in ("POST", "PUT", "PATCH"):
            connection.putheader("content-length", str(len(body or b"")))
        connection.endheaders(body)
        answer = connection.getresponse()
    except (OSError, http.client.HTTPException) as error:
        watchdog.cancel()
        connection.close()
        cause = ("timeout" if connected else "connect_timeout") if watchdog.fired else cause_of(error, connected)
        raise Failure(cause, connected, watchdog.fired) from None
    return Response(connection, answer, watchdog)
