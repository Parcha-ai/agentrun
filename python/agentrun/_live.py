"""runs.wait and runs.follow: a run until it ends or waits on a person, and its timeline as it changes. Hand-written over
the timeline route's two forms, the long-polled JSON page and the event stream, as packages/client/src/live.ts is."""

from __future__ import annotations

import codecs
import json
import math
import re
import socket
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, NoReturn, Optional, cast

from ._errors import AgentRunError, AgentRunRefused, AgentRunTimeout, AgentRunUnreachable, AgentRunUsage
from ._generated import Run, TimelinePage
from ._http import CHUNK, MAX_RETRY_AFTER, Exchange, Late, Response, StreamedResponse, backoff, pause, segment_of

Send = Callable[[Exchange], Response]

TERMINAL = frozenset({"completed", "failed", "cancelled"})
# What moves only once a person acts: input_required (a question, the spend cap, a stopped turn) and a workflow's paused.
PERSON = frozenset({"input_required", "paused"})
MAX_WAIT_MS = 25_000  # the route's wait_ms maximum
IDLE = 45.0  # three of the stream's 15 s keepalives missed: the connection is gone
LAST_READ = 1.0  # the read of the run once a wait's time is up
RETRIES = 5  # tries in a row that get no event before follow gives up

TIMELINE = "GET /runs/{run_id}/timeline"
RUN = "GET /runs/{run_id}"


def seconds_of(value: object, name: str) -> float:
    """A number of seconds above 0, as a timeout takes it."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise AgentRunUsage(f"{name} must be a number of seconds above 0.")
    return float(value)


def _get_json(send: Send, path: str, route: str, deadline: float) -> Dict[str, Any]:
    """GET `path` as a JSON object, tried again as any GET is, ending by `deadline`."""
    response = send(Exchange("GET", path, route, retryable=True, deadline=deadline, timeout=MAX_WAIT_MS / 1000 + IDLE))
    try:
        value = json.loads((response.data or b"").decode("utf-8"))
    except ValueError:
        value = None
    if isinstance(value, dict):
        return cast(Dict[str, Any], value)
    raise AgentRunRefused(route, response.status, "bad_answer", None, f"The server's answer to {route} is not a JSON object.")


def wait_run(send: Send, run_id: str, timeout: Optional[float]) -> Run:
    """Long-polls the timeline from change to change and reads the run when a page says it ended or waits on a person."""
    run_path = segment_of(run_id, "run_id", False)
    limit = None if timeout is None else seconds_of(timeout, "timeout")
    deadline = math.inf if limit is None else time.monotonic() + limit
    after = 0
    last: Optional[Run] = None

    def late() -> NoReturn:
        nonlocal last
        try:
            last = cast(Run, _get_json(send, f"/runs/{run_path}", RUN, time.monotonic() + LAST_READ))
        except (Late, AgentRunUnreachable):
            pass
        raise AgentRunTimeout(run_id, limit or 0.0, last) from None

    def ended(status: object, final: bool) -> bool:
        return (status in TERMINAL and final) or status in PERSON

    try:
        first = True
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                late()
            wait_ms = 0 if first else MAX_WAIT_MS if math.isinf(left) else min(MAX_WAIT_MS, math.ceil(left * 1000))
            first = False
            page = _get_json(send, f"/runs/{run_path}/timeline?after={after}&wait_ms={wait_ms}", TIMELINE, deadline)
            next_after = page.get("next_after")
            if not isinstance(next_after, int) or isinstance(next_after, bool) or not isinstance(page.get("status"), str):
                raise AgentRunRefused(TIMELINE, 200, "bad_answer", None, f"The server's answer to {TIMELINE} is not a timeline page.")
            after = next_after
            if ended(page["status"], page.get("final") is True):
                run = _get_json(send, f"/runs/{run_path}", RUN, deadline)
                last = cast(Run, run)
                # A message can reopen the run between the two reads: then it is waited for again.
                if ended(run.get("status"), True):
                    return last
            if page.get("unchanged") and not page.get("has_more"):
                poll = page.get("poll_after_ms")
                every = poll / 1000 if isinstance(poll, (int, float)) and not isinstance(poll, bool) and poll >= 0 else 1.0
                pause(min(every, max(0.001, deadline - time.monotonic())))
    except Late:
        late()


@dataclass
class Event:
    event: str
    data: str
    id: Optional[str]
    retry: Optional[int]


_LINE = re.compile(r"\r\n|\r|\n")


def events(stream: StreamedResponse) -> Iterator[Event]:
    """The events of a text/event-stream body as the HTML standard parses them, each once its blank line came, so an
    event cut off midway is never seen. `id` is the last id field seen, carried from event to event; only digits, the
    route's change numbers, are kept, so nothing else is ever sent back as a header."""
    # utf-8-sig: a byte order mark the stream begins with is no part of its first field.
    decoder = codecs.getincrementaldecoder("utf-8-sig")(errors="replace")
    buffer = ""
    name = ""
    data: List[str] = []
    retry: Optional[int] = None
    seen: Optional[str] = None
    while True:
        chunk = stream.read1(CHUNK)
        if not chunk:
            return
        text = buffer + decoder.decode(chunk)
        # A CR at the end may be the first half of a CRLF still to come.
        held = "\r" if text.endswith("\r") else ""
        if held:
            text = text[:-1]
        lines = _LINE.split(text)
        buffer = lines.pop() + held
        for line in lines:
            if line == "":
                if data or retry is not None:
                    yield Event((name or "message") if data else "", "\n".join(data), seen, retry)
                name, data, retry = "", [], None
            elif not line.startswith(":"):
                field, colon, value = line.partition(":")
                value = value[1:] if colon and value.startswith(" ") else value
                if field == "event":
                    name = value
                elif field == "data":
                    data.append(value)
                elif field == "id" and value.isdigit() and value.isascii():
                    seen = value
                elif field == "retry" and value.isdigit() and value.isascii():
                    retry = int(value)


def _object_of(data: str, what: str) -> Dict[str, Any]:
    try:
        value = json.loads(data)
    except ValueError:
        value = None
    if isinstance(value, dict):
        return cast(Dict[str, Any], value)
    raise AgentRunRefused(TIMELINE, 200, "bad_answer", None, f"The server sent a {what} event that is not a JSON object.")


def follow_run(send: Send, base_url: str, run_id: str, after: object, last_event_id: object, idle_timeout: object) -> Iterator[TimelinePage]:
    """The timeline's event stream, each `rows` event's page as the server sent it. Its arguments are checked here, at
    the call, before anything is sent; the pages come as the iterator is read."""
    run_path = segment_of(run_id, "run_id", False)
    if after is not None and (isinstance(after, bool) or not isinstance(after, int) or after < 0):
        raise AgentRunUsage("after must be a whole number, 0 or more.")
    idle = IDLE if idle_timeout is None else seconds_of(idle_timeout, "idle_timeout")
    last: Optional[str] = None
    if last_event_id is not None:
        if not isinstance(last_event_id, str) or not last_event_id.isdigit() or not last_event_id.isascii():
            raise AgentRunUsage("last_event_id must be an event id the server sent: digits only.")
        last = last_event_id
    path = f"/runs/{run_path}/timeline{f'?after={after}' if after is not None else ''}"
    return _follow(send, base_url, path, last, idle)


def _follow(send: Send, base_url: str, path: str, last: Optional[str], idle: float) -> Iterator[TimelinePage]:
    """A dropped connection, an `end` with reason reconnect, or a stream silent past `idle` reconnects with
    Last-Event-ID; tries that get no event back off, never under the server's `retry`, and give up after a few in a row
    (AgentRunUnreachable). It ends at the server's `end` with reason terminal."""
    retry = 0.0
    reached = False
    tries = 0
    while True:
        progress = False
        reconnect = False
        cause = "stream_closed"
        # A gateway's Retry-After: the least wait before the next try, capped as a GET's retry is.
        floor = 0.0
        try:
            response: Optional[Response] = None
            headers = {"accept": "text/event-stream", **({"last-event-id": last} if last is not None else {})}
            try:
                # The try's timeout is the idle one: a server silent that long before its head is gone too.
                response = send(Exchange("GET", path, TIMELINE, retryable=False, streamed=True, timeout=idle, headers=headers))
                reached = True
            except AgentRunRefused as error:
                # A server that never answered is unreachable now; once it has, a dropped connection, silence or a
                # gateway's 502, 503 or 504 reconnects. Every other refusal is the call's outcome.
                if error.status not in (502, 503, 504):
                    raise
                reached = True
                cause = f"http_{error.status}"
                floor = min(error.retry_after or 0.0, MAX_RETRY_AFTER)
            except AgentRunUnreachable as error:
                silent = error.cause == "timeout"
                if not (reached or silent):
                    raise
                reached = True
                cause = "stream_silent" if silent else error.cause
            if response is not None:
                stream = response.stream(idle)
                try:
                    if not re.match(r"text/event-stream\b", response.headers.get("content-type") or "", re.IGNORECASE):
                        raise AgentRunRefused(TIMELINE, response.status, "bad_answer", None, f"The server answered {TIMELINE} with something other than an event stream.")
                    for event in events(stream):
                        if event.retry is not None:
                            # Capped as a Retry-After is: a server's retry is never a reason to wait longer.
                            retry = min(event.retry / 1000, MAX_RETRY_AFTER)
                        if event.id is not None:
                            last = event.id
                        if event.event == "rows":
                            progress = True
                            # The idle timeout measures the server's silence: no read waits while the page is out.
                            yield cast(TimelinePage, _object_of(event.data, "rows"))
                        if event.event == "end":
                            if _object_of(event.data, "end").get("reason") == "terminal":
                                return
                            reconnect = True
                            break
                finally:
                    stream.close()
        except AgentRunError:
            # An outcome of this client's is the call's.
            raise
        except Exception as error:  # noqa: BLE001 - whatever broke the stream's read is a dropped connection
            # What broke while the stream was read is a dropped connection.
            cause = "stream_silent" if isinstance(error, (socket.timeout, TimeoutError)) else "stream_broken"
        if reconnect:
            tries = 0
            pause(retry)
            continue
        # The stream ended with no `end`, or broke: the connection dropped.
        tries = 1 if progress else tries + 1
        if tries > RETRIES:
            raise AgentRunUnreachable(base_url, cause)
        pause(backoff(tries, max(retry, floor)))
