"""The client: AgentRun(base_url, api_key), a method per operation (_generated.py), and the rules every client of the
server keeps. The key goes only to its own base URL, in the Authorization header, and is checked to be a valid header
value before any request; no error holds it. A path argument is encoded whole (a file path keeps its slashes), and one
that would read as another route is refused before anything is sent. Only a GET, or a request that carries an
Idempotency-Key, is tried again. A secret body's values are cut from the answer to it."""

from __future__ import annotations

import itertools
import json
import math
import os
import re
import ssl
import time
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Tuple, cast
from urllib.parse import urlencode, urljoin, urlsplit

from ._errors import AgentRunAuthError, AgentRunError, AgentRunRefused, AgentRunUnreachable, AgentRunUnsupported, AgentRunUsage, ServerError
from ._generated import OPERATIONS, Resources, Run, RunsResource, TimelinePage
from ._http import (
    BAD_HEADER,
    MAX_RETRY_AFTER,
    NOT_CONNECTED,
    UNTRUSTED,
    Exchange,
    Failure,
    Late,
    Origin,
    Response,
    Secret,
    attempt,
    backoff,
    failure_of,
    pause,
    retry_after_of,
    segment_of,
)
from ._live import follow_run, seconds_of, wait_run
from ._scrub import scrubber_of, secrets_of
from ._types import Call, Operation, Tagged

JSON_TYPE = re.compile(r"^application/(?:[\w.+-]+\+)?json\b", re.IGNORECASE)
RETRIABLE = frozenset({429, 500, 502, 503, 504})
REDIRECT = frozenset({301, 302, 303, 307, 308})
MAX_HOPS = 5
USER_AGENT = "parcha-agentrun-python"
# What a URL may hold as this client sends it: printable ASCII, no space.
URL_TEXT = re.compile(r"[\x21-\x7e]*")
_SURROGATE = re.compile("[\ud800-\udfff]")


def _key_from_environment() -> Optional[Secret]:
    value = os.environ.get("AGENTRUN_API_KEY")
    return None if value is None else Secret(value)


def _base_of(given: Optional[str], where: str) -> str:
    """A base URL as the client takes it; `where` names it in the refusal. The URL itself is never echoed: it may hold a
    password."""
    if given is None or given == "":
        raise AgentRunUsage("No server: pass base_url, or set AGENTRUN_BASE_URL, to the API's base (ending /v2).")
    why = f"{where} must be an http or https URL with no query, fragment, user, password, space or . or .. segment: the API's base, ending /v2."
    if not isinstance(given, str) or not URL_TEXT.fullmatch(given) or "?" in given or "#" in given:  # pyright: ignore[reportUnnecessaryIsInstance]
        raise AgentRunUsage(why)
    parts = urlsplit(given)
    try:
        parts.port
    except ValueError:
        raise AgentRunUsage(why) from None
    dotted = any(re.sub("%2e", ".", segment, flags=re.IGNORECASE) in (".", "..") for segment in parts.path.split("/"))
    if parts.scheme not in ("http", "https") or not parts.hostname or "@" in parts.netloc or dotted:
        raise AgentRunUsage(why)
    try:
        # The host as a connection names it: a label IDNA refuses (empty, or over 63 characters) is refused here.
        parts.hostname.encode("idna")
    except UnicodeError:
        raise AgentRunUsage(f"{where} names a host that is not a valid host name.") from None
    return given.rstrip("/")


def _origin_of(url: str) -> Optional[Origin]:
    """Where `url` connects: its scheme, host and port; None for a URL with a user or password, or one this client
    cannot send."""
    parts = urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or "@" in parts.netloc:
        return None
    return Origin(parts.scheme, parts.hostname, port or (443 if parts.scheme == "https" else 80))


def _positive(value: object, name: str) -> float:
    return seconds_of(value, name)


def _whole(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AgentRunUsage(f"{name} must be a whole number, 0 or more.")
    return value


def _query_text(value: object) -> str:
    """A query value as the server reads it: JSON's booleans and numbers, as the TypeScript client sends them."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    # A lone surrogate has no UTF-8: it goes as U+FFFD, as URLSearchParams sends it.
    return _SURROGATE.sub("\ufffd", str(value))


def _secret_at(method: str, url: str) -> Optional[Operation]:
    """The secret operation `method` on `url` reaches: the route at the end of the path, whatever part of it the base
    URL holds."""
    pathname = re.sub(r"/{2,}", "/", urlsplit(url).path)
    for op in OPERATIONS.values():
        if op.secret and op.method == method:
            pattern = "[^/]+".join(re.escape(part) for part in re.split(r"\{[^}]+\}", op.path[1:]))
            if re.search(f"(?:^|/){pattern}/?$", pathname):
                return op
    return None


def _bad_answer(route: str, status: int, what: str) -> AgentRunRefused:
    return AgentRunRefused(route, status, "bad_answer", None, f"The server's answer to {route} is not {what}.")


def _read_answer(op: Operation, route: str, response: Response, stream: bool, timeout: float, scrub: Optional[Callable[[Any], Any]]) -> Any:
    """A success's body as the operation answers: JSON parsed (a secret body's values cut from it), text as a str, a
    file's bytes as they came, or a StreamedResponse for a download asked to stream."""
    if op.answer == "bytes" and scrub is None:
        return response.stream(timeout) if stream else response.read()
    if op.answer == "none":
        response.close()
        return None
    data = response.read()
    if response.status == 204 or not data:
        return None if "json" in op.answer else "" if op.answer == "text" else data
    kind = response.headers.get("content-type") or ""
    if scrub is not None or ("json" in op.answer and (JSON_TYPE.match(kind) or op.answer == "json")):
        if not JSON_TYPE.match(kind):
            raise _bad_answer(route, response.status, "JSON")
        try:
            value = json.loads(data.decode("utf-8"))
        except ValueError:
            raise _bad_answer(route, response.status, "JSON") from None
        return scrub(value) if scrub is not None else value
    if "text" in op.answer and (re.match(r"text/", kind, re.IGNORECASE) or "bytes" not in op.answer):
        return data.decode("utf-8", errors="replace")
    return data


class Runs(RunsResource):
    """client.runs: one method per operation, and wait and follow."""

    def __init__(self, call: Call, send: Callable[[Exchange], Response], base_url: str) -> None:
        super().__init__(call)
        self._send = send
        self._base_url = base_url

    def wait(self, run_id: str, *, timeout: Optional[float] = None) -> Run:
        """Waits until the run ends (completed, failed or cancelled, every row in) or waits on a person
        (input_required, paused), and returns the run. Past `timeout` seconds it raises AgentRunTimeout, and the run
        goes on. Default: no limit."""
        return wait_run(self._send, run_id, timeout)

    def follow(self, run_id: str, *, after: Optional[int] = None, last_event_id: Optional[str] = None, idle_timeout: Optional[float] = None) -> Iterator[TimelinePage]:
        """The run's timeline as it changes: each page the server's event stream sends, until the run ends. A dropped
        connection resumes with Last-Event-ID, so no change comes twice. `after` starts after a change number (the
        timeline's next_after); `last_event_id` resumes after an event id, as a reconnect does, and wins over `after`;
        `idle_timeout` is how long the stream may stay silent before it counts as dropped (default 45 s: three of its
        15 s keepalives missed). Its arguments are checked at the call, before anything is sent."""
        return follow_run(self._send, self._base_url, run_id, after, last_event_id, idle_timeout)


class AgentRun(Resources):
    """A client for one AgentRun server. The local server's discovery (its data directory, its record of its address) is
    the CLI's: this client reads no file, only its arguments and the environment.

    `base_url` is the server's API, ending /v2 (default: AGENTRUN_BASE_URL): http or https, with no query, fragment,
    user or password. `api_key` defaults to AGENTRUN_API_KEY. `timeout` is how long one try of a request may take, its
    answer read included, in seconds; every method takes its own `timeout=` too, and that is how a call is cancelled.
    `max_retries` is how many times a GET, or a request with an Idempotency-Key, is tried again after a 429, a 5xx or a
    dropped connection."""

    runs: Runs

    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None, timeout: float = 60.0, max_retries: int = 4) -> None:
        # The key is a Secret from its first line here on, the environment's too, so no frame's locals show it.
        api_key = Secret(api_key) if isinstance(api_key, str) else api_key
        self.base_url = _base_of(base_url if base_url is not None else os.environ.get("AGENTRUN_BASE_URL"), "base_url" if base_url is not None else "AGENTRUN_BASE_URL")
        self.timeout = _positive(timeout, "timeout")
        self.max_retries = _whole(max_retries, "max_retries")
        key = api_key if api_key is not None else _key_from_environment()
        if not key:
            raise AgentRunAuthError("no_token", "No API key: pass api_key, or set AGENTRUN_API_KEY.")
        # Refused before it is sent: http.client would quote a bad header value in its error.
        if not isinstance(key, str) or BAD_HEADER.search(key) or re.search(r"\s", key):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise AgentRunAuthError("bad_header", "The API key is not a valid header value (it holds a space, a line break, a control character or a character outside Latin-1).")
        self._key: Secret = key
        origin = _origin_of(self.base_url)
        assert origin is not None
        self._origin = origin
        self._base_path = urlsplit(self.base_url).path
        self._context = ssl.create_default_context() if origin.scheme == "https" else None
        self._reached = False
        super().__init__(self._operation_call)
        self.runs = Runs(self._operation_call, self._send, self.base_url)

    def __repr__(self) -> str:
        return f"AgentRun(base_url={self.base_url!r})"

    def _operation_call(
        self,
        operation_id: str,
        args: Tuple[str, ...],
        body: object,
        params: Optional[Mapping[str, object]],
        *,
        timeout: Optional[float] = None,
        stream: bool = False,
        body_type: Optional[str] = None,
    ) -> Any:
        """One generated operation: its arguments checked, then sent, then its answer read."""
        op = OPERATIONS[operation_id]
        route = f"{op.method} {op.path}"
        if timeout is not None:
            _positive(timeout, "timeout")
        path = re.sub(r"\{([^}]+)\}", lambda match: segment_of(args[op.path_params.index(match.group(1))], match.group(1), match.group(1) in op.multi_segment), op.path)
        given: Mapping[str, object] = params or {}
        query = urlencode([(name, _query_text(given[name])) for name in op.query if given.get(name) is not None])
        headers: Dict[str, str] = {}
        for name in op.headers:
            value = given.get(name)
            if value is None:
                continue
            if not isinstance(value, str) or BAD_HEADER.search(value):
                raise AgentRunUsage(f"{name} is not a valid header value.")
            headers[name] = value
        sent: Optional[bytes] = None
        text: Optional[str] = None
        try:
            if op.body is not None and body is not None:
                other = next((kind for kind in op.body.types if not JSON_TYPE.match(kind)), None)
                if isinstance(body, (bytes, bytearray, memoryview, str)) and other is not None:
                    kind = body_type if body_type is not None else "application/octet-stream" if other == "*/*" else other
                    if not isinstance(kind, str) or BAD_HEADER.search(kind):  # pyright: ignore[reportUnnecessaryIsInstance]
                        raise AgentRunUsage("body_type is not a valid header value.")
                    headers["content-type"] = kind
                    sent = body.encode("utf-8") if isinstance(body, str) else bytes(cast(bytes, body))
                else:
                    try:
                        text = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                    except (TypeError, ValueError):
                        raise AgentRunUsage(f"The body of {route} cannot be sent as JSON.") from None
                    headers["content-type"] = "application/json"
                    sent = text.encode("utf-8")
            elif op.body is not None and op.body.required:
                raise AgentRunUsage(f"{route} needs a body.")
        except UnicodeEncodeError:
            raise AgentRunUsage(f"The body of {route} is not text that can be sent: it holds a lone surrogate.") from None
        # A body bound for a secret route, the base URL's own path counted: its values are cut from the answer.
        url = f"{self.base_url}{path}{f'?{query}' if query else ''}"
        secret_op = op if op.secret else _secret_at(op.method, url)
        if secret_op is not None and sent is not None and text is None:
            raise AgentRunUsage(f"{route} under {self.base_url} reaches {secret_op.method} {secret_op.path}, whose body is a secret: send it as JSON.")
        found = secrets_of(text, secret_op.public_fields) if secret_op is not None and text is not None else []
        streamed = op.answer == "bytes" and stream
        response = self._send(Exchange(
            op.method, url[len(self.base_url):], route, retryable=op.method == "GET" or "Idempotency-Key" in headers, headers=headers, body=sent,
            timeout=timeout, secret=secret_op is not None, secrets=found, streamed=streamed,
        ))
        answer = _read_answer(op, route, response, streamed, timeout or self.timeout, scrubber_of(found) if secret_op is not None else None)
        return Tagged(answer, response.headers.get("etag")) if op.tagged else answer

    def _send(self, x: Exchange) -> Response:
        """One request to the server with the key: tried again when it may be, its redirects followed only within the
        base URL's origin, and any answer but a success raised as its outcome. Returns the success, its body read
        unless the exchange streams it."""
        deadline = x.deadline if x.deadline is not None else math.inf
        for tries in itertools.count(1):
            left = deadline - time.monotonic()
            if left <= 0:
                raise Late()
            seconds = min(x.timeout if x.timeout is not None else self.timeout, left)
            # A try that runs to the call's deadline: when it times out, the call is late.
            last = seconds >= left
            try:
                response = self._follow(x, seconds)
                self._reached = True
                if response.ok and not x.streamed:
                    try:
                        response.read()
                    except Exception as error:  # noqa: BLE001 - every failure of a try is its outcome, as a code
                        raise failure_of(error, response.timed_out) from None
            except Failure as failure:
                if (failure.late and last) or time.monotonic() >= deadline:
                    raise Late() from None
                cause = failure.cause
                # A server never reached is unreachable at once; a dropped connection is tried again, even on the first
                # request, and so is a refused one once the server has answered before (it may be restarting); a
                # timeout is not. A certificate the client refuses stays refused, so it is never tried again.
                never_reached = not self._reached and cause in NOT_CONNECTED
                if failure.final or not x.retryable or never_reached or UNTRUSTED.search(cause) or cause == "timeout" or tries > self.max_retries:
                    raise AgentRunUnreachable(self.base_url, cause) from None
                pause(min(backoff(tries), deadline - time.monotonic()))
                continue
            # Retry-After is read only where it is used: never on a success's way out.
            wait = retry_after_of(response.headers) if x.retryable and response.status in RETRIABLE and tries <= self.max_retries else math.inf
            if wait <= MAX_RETRY_AFTER:
                response.close()
                pause(min(backoff(tries, wait), max(0.001, deadline - time.monotonic())))
                continue
            if response.ok:
                return response
            raise self._refusal(x, response, last, deadline)
        raise AssertionError("unreachable")  # pragma: no cover - itertools.count never ends

    def _follow(self, x: Exchange, seconds: float) -> Response:
        """One try with the key, following a redirect only for a GET and only within the base URL's origin: the key
        never goes to another server. Any other redirect is refused (code "redirect")."""
        end = time.monotonic() + seconds
        headers: Dict[str, str] = {"accept": "application/json, */*", "user-agent": USER_AGENT}
        headers.update({name.lower(): value for name, value in x.headers.items()})
        target = f"{self._base_path}{x.path}"
        for hops in itertools.count():
            response = attempt(self._origin, x.method, target, list(headers.items()), self._key, x.body, end, self._context)
            if response.status not in REDIRECT:
                return response
            response.close()
            location = response.headers.get("location")
            here = f"{self._origin.scheme}://{urlsplit(self.base_url).netloc}{target}"
            following = urljoin(here, location) if location and URL_TEXT.fullmatch(location) else None
            home = following is not None and _origin_of(following) == self._origin
            if not home or x.method != "GET" or hops >= MAX_HOPS:
                how = "this client does not follow" if home else "to another origin"
                raise AgentRunRefused(x.route, response.status, "redirect", None, f"The server answered {x.route} with a redirect {how} ({response.status}); not followed, so the API key stays with {self.base_url}.")
            assert following is not None
            parts = urlsplit(following)
            target = f"{parts.path or '/'}{f'?{parts.query}' if parts.query else ''}"
        raise AssertionError("unreachable")  # pragma: no cover

    def _refusal(self, x: Exchange, response: Response, last: bool, deadline: float) -> AgentRunError:
        """A refused answer as its outcome. The server's error object is kept with every copy of the key cut from it;
        after a secret body, with the body's values cut too, only its code, and a code that held one is no code. Its
        text is never read into a message. A read that ends at the exchange's deadline (a wait's timeout) is Late: late
        work is never reported as a refusal or a bad key."""
        error: Optional[ServerError] = None
        try:
            parsed: object = json.loads(response.read().decode("utf-8"))
            found: object = cast(Dict[str, Any], parsed).get("error") if isinstance(parsed, dict) else None
            if isinstance(found, dict):
                error = scrubber_of([self._key.reveal(), *x.secrets])(cast(ServerError, found))
        except Exception:  # noqa: BLE001 - a body that cannot be read or parsed is no error object

            if (response.timed_out and last) or time.monotonic() >= deadline:
                raise Late() from None
            error = None
        named: object = error.get("code") if error is not None else None
        code = named if isinstance(named, str) and re.fullmatch(r"[a-z0-9_]+", named) else None
        if x.secret:
            error = {"code": code} if code else None
        if response.status in (401, 403):
            return AgentRunAuthError("refused", f"The server refused the API key for {x.route}: {response.status}{f' {code}' if code else ''}.", response.status, code, error)
        if response.status == 501:
            return AgentRunUnsupported(x.route, response.status, code, error)
        wait = retry_after_of(response.headers)
        return AgentRunRefused(x.route, response.status, code, error, None, wait if wait > 0 else None)

