"""The rules every client of the server keeps, against loopback listeners that play a hostile server, ported one for one
from packages/client/test/rules.test.mjs: the key goes only to its own origin, never into a message; a key or an
argument that would be wrong on the wire is refused before any request; a secret body's values are cut from the answer
as JSON values; only what may be tried again is; a wait ends by its timeout; a dropped stream resumes where it left off;
a download comes back byte for byte."""

from __future__ import annotations

import errno
import json
import os
import pickle
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import traceback
import unittest
from typing import Any, Optional
from unittest import mock
from urllib.parse import parse_qs, quote, urlsplit

from helpers import JSON_HEADERS, KEY, Listener, Reply, Request, free_port, json_answer, printed

from agentrun import (
    OPERATIONS,
    AgentRun,
    AgentRunAuthError,
    AgentRunError,
    AgentRunRefused,
    AgentRunTimeout,
    AgentRunUnreachable,
    AgentRunUnsupported,
    AgentRunUsage,
    StreamedResponse,
    Tagged,
)
import agentrun
from agentrun._scrub import scrubber_of, secrets_of

# The package's own directory: a frame is the client's when its file is under it, whatever the checkout's path holds.
PACKAGE = os.path.dirname(os.path.abspath(agentrun.__file__)) + os.sep


def page(**fields: Any) -> dict[str, Any]:
    return {"run_id": "r1", "status": "working", "state": "working", "reset": False, "rows": [], "drop": [], "next_after": 1, "unchanged": True, "has_more": False, "final": False, "cost": {"usd": 0}, "poll_after_ms": 50, **fields}


class Rules(unittest.TestCase):
    def thrown(self, call: Any, *args: Any, **kwargs: Any) -> BaseException:
        try:
            call(*args, **kwargs)
        except BaseException as error:  # noqa: BLE001 - the test reads what was thrown
            return error
        self.fail("it did not raise")

    def test_a_redirect_to_another_origin_is_not_followed_and_a_get_redirect_within_the_origin_is_followed_with_the_key(self) -> None:
        elsewhere = Listener(self)
        home: Listener

        def answer(request: Request, reply: Reply) -> Any:
            if request.url == "/v2/agents":
                return 302, {"location": f"{elsewhere.base}/agents"}, ""
            if request.url == "/v2/runs":
                return 307, {"location": f"{home.prefix}/v2/runs-moved"}, ""
            if request.url == "/v2/runs-moved":
                return json_answer(200, {"runs": [], "next_cursor": None})
            if request.url == "/v2/runs/r1/messages":
                return 307, {"location": f"{home.prefix}/v2/runs/r2/messages"}, ""
            return json_answer(404, {"error": {"code": "not_found"}})

        home = Listener(self, answer)
        client = AgentRun(base_url=home.base, api_key=KEY)
        away = self.thrown(client.agents.list)
        self.assertIsInstance(away, AgentRunRefused)
        assert isinstance(away, AgentRunRefused)
        self.assertEqual((away.status, away.code), (302, "redirect"))
        self.assertIn("another origin", str(away))
        self.assertEqual(elsewhere.requests, [], "nothing went to the other origin")

        self.assertEqual(client.runs.list(), {"runs": [], "next_cursor": None})
        self.assertEqual([(r.url, r.headers["authorization"]) for r in home.requests[1:]], [("/v2/runs", f"Bearer {KEY}"), ("/v2/runs-moved", f"Bearer {KEY}")])
        posted = self.thrown(client.runs.message, "r1", {"content": "hi"})
        assert isinstance(posted, AgentRunRefused)
        self.assertEqual((posted.status, posted.code), (307, "redirect"), "a POST is never redirected, even home")
        self.assertEqual(home.requests[-1].url, "/v2/runs/r1/messages")
        for error in (away, posted):
            self.assertNotIn(KEY, printed(error))

    def test_an_error_body_that_echoes_the_key_never_reaches_a_message_and_the_error_object_keeps_its_shape_with_the_key_cut(self) -> None:
        def answer(request: Request, reply: Reply) -> Any:
            if request.url == "/v2/agents":
                return json_answer(400, {"error": {"code": "bad_request", "message": f"Bad key {KEY}", "retryable": False, "details": {KEY: [KEY, quote(KEY, safe="")]}}})
            if request.url == "/v2/agents/a":
                return 401, {"content-type": "text/plain"}, f"no such key: {KEY}"
            if request.url == "/v2/runs":
                return 500, {"content-type": "text/html"}, f"<p>{KEY}</p>"
            return json_answer(403, {"error": {"code": "forbidden", "message": KEY}})

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY, max_retries=0)
        bad = self.thrown(client.agents.list)
        assert isinstance(bad, AgentRunRefused)
        self.assertIsInstance(bad, AgentRunError)
        self.assertEqual((bad.kind, bad.status, bad.code), ("refused", 400, "bad_request"))
        self.assertEqual(bad.error, {"code": "bad_request", "message": "Bad key [hidden]", "retryable": False, "details": {"[hidden]": ["[hidden]", "[hidden]"]}})
        unauthenticated = self.thrown(client.agents.get, "a")
        assert isinstance(unauthenticated, AgentRunAuthError)
        self.assertEqual((unauthenticated.reason, unauthenticated.status, unauthenticated.error), ("refused", 401, None), "a text body is never read into the error")
        failed = self.thrown(client.runs.list)
        assert isinstance(failed, AgentRunRefused)
        self.assertEqual((failed.status, failed.code, failed.error), (500, None, None))
        forbidden = self.thrown(client.agents.archive, "a")
        assert isinstance(forbidden, AgentRunAuthError)
        self.assertEqual((forbidden.kind, forbidden.reason, forbidden.code), ("auth", "refused", "forbidden"))
        for error in (bad, unauthenticated, failed, forbidden):
            self.assertNotIn(KEY, printed(error))
        self.assertNotIn(KEY, printed(client), "nor does the printed client")

    def test_a_bad_key_a_missing_key_and_a_base_url_that_would_carry_it_elsewhere_are_refused_before_any_request(self) -> None:
        server = Listener(self)
        for api_key in (f"{KEY}\nX-Other: 1", f"{KEY} ", "a\tb", "ключ", "a\x7f"):
            error = self.thrown(AgentRun, base_url=server.base, api_key=api_key)
            assert isinstance(error, AgentRunAuthError), api_key
            self.assertEqual(error.reason, "bad_header")
            self.assertNotIn(api_key, printed(error))
        with mock.patch.dict(os.environ, {"AGENTRUN_BASE_URL": server.base}):
            os.environ.pop("AGENTRUN_API_KEY", None)
            missing = self.thrown(AgentRun)
            assert isinstance(missing, AgentRunAuthError)
            self.assertEqual(missing.reason, "no_token")
            empty = self.thrown(AgentRun, api_key="")
            assert isinstance(empty, AgentRunAuthError)
            self.assertEqual(empty.reason, "no_token")
            os.environ["AGENTRUN_API_KEY"] = KEY
            from_env = AgentRun()
            self.assertEqual(from_env.base_url, server.base, "the environment's server and key")
            self.assertEqual((from_env.timeout, from_env.max_retries), (60.0, 4), "the TypeScript client's defaults")
        split = urlsplit(server.base)
        with_user = f"{split.scheme}://user:{KEY}@{split.netloc}{split.path}"
        for base_url in (f"{server.base}?x=1", f"{server.base}#x", with_user, "ftp://example.com/v2", "not a url", "http://", f"{server.base}/a b", f"{split.scheme}://{split.netloc}/x/../v2"):
            error = self.thrown(AgentRun, base_url=base_url, api_key=KEY)
            assert isinstance(error, AgentRunUsage), base_url
            self.assertNotIn(base_url, str(error))
            self.assertNotIn(KEY, printed(error))
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AGENTRUN_BASE_URL", None)
            self.assertIsInstance(self.thrown(AgentRun, api_key=KEY), AgentRunUsage, "no server")
        for options in ({"timeout": 0}, {"timeout": -1.0}, {"timeout": float("nan")}, {"max_retries": -1}, {"max_retries": 1.5}, {"max_retries": True}):
            self.assertIsInstance(self.thrown(AgentRun, base_url=server.base, api_key=KEY, **options), AgentRunUsage, options)
        self.assertEqual(server.requests, [], "nothing was sent")
        from_env.agents.list()
        self.assertEqual(server.requests[0].headers["authorization"], f"Bearer {KEY}")

    def test_a_path_argument_is_encoded_whole_a_file_path_keeps_its_slashes_and_one_that_would_read_as_another_route_is_refused_before_any_request(self) -> None:
        def answer(request: Request, reply: Reply) -> Any:
            if "/files/" in request.url and "learning" not in request.url:
                return 200, {"content-type": "application/octet-stream"}, "x"
            return json_answer(200, {})

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        refused: list[Any] = [
            lambda: client.runs.get(".."), lambda: client.runs.get("."), lambda: client.runs.get(""), lambda: client.runs.get("%2e%2E"), lambda: client.runs.get("a/../b"),
            lambda: client.learning.read("a", ".."), lambda: client.learning.read("a", "x/./y"),
            lambda: client.runs.get(3),  # type: ignore[arg-type]
            lambda: client.runs.start("a", {"input": {}}, idempotency_key="a\r\nX-Other: 1"),
        ]
        for path in ("a/%2e%2e/b", "%2e", "a%2Fb", "a/../b", "./b", "a//b", "a/", "/a"):
            refused += [lambda path=path: client.runs.read_file("r1", path), lambda path=path: client.home.read("a", path)]
        for call in refused:
            error = self.thrown(call)
            self.assertIsInstance(error, AgentRunUsage, repr(error))
        self.assertEqual(server.requests, [], "nothing was sent")
        client.learning.read("a", "skills/find-policies/SKILL.md")
        client.home.read("a", "notes/a b.md")
        client.runs.get("a b/c?d#e")
        self.assertEqual([r.url for r in server.requests], ["/v2/agents/a/learning/files/skills%2Ffind-policies%2FSKILL.md", "/".join(["", "v2", "agents", "a", "home", "files", "notes", "a%20b.md"]), "/v2/runs/a%20b%2Fc%3Fd%23e"])

    def test_a_secret_bodys_values_are_cut_from_the_answer_as_json_values_its_structure_and_public_fields_kept_and_a_refusal_keeps_only_its_code(self) -> None:
        secret = f's3cr"et/{secrets.token_hex(8)} x'
        header = f"h-{secrets.token_hex(8)}"
        escaped = json.dumps(secret)[1:-1]
        encoded = quote(secret, safe="-_.!~*'()")

        def answer(request: Request, reply: Reply) -> Any:
            body = json.loads(request.body)
            if request.url == "/v2/settings/mcp-servers/refused":
                return json_answer(422, {"error": {"code": "input_invalid", "message": f"bad token {secret}", "fields": [{"field": "auth.token", "value": secret}]}})
            return json_answer(200, {"name": "docs", "url": body["url"], "auth": body["auth"], "echo": f"token {escaped} and {encoded}", secret: {header: header}, "list": [secret, 1, None, True], "tools": []})

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        saved = client.mcp_servers.save("docs", {"url": "https://mcp.example.com/mcp", "auth": {"type": "headers", "headers": {"X-Secret-Header": header}}})
        self.assertEqual(saved, {
            "name": "docs", "url": "https://mcp.example.com/mcp", "auth": {"type": "headers", "headers": {"X-Secret-Header": "[hidden]"}},
            "echo": f"token {escaped} and {encoded}", secret: {"[hidden]": "[hidden]"}, "list": [secret, 1, None, True], "tools": [],
        }, "only the body's own secret values are cut: here the header")
        previewed: Any = client.mcp_servers.preview({"url": "https://mcp.example.com/mcp", "auth": {"type": "bearer", "token": secret}})
        text = json.dumps(previewed, ensure_ascii=False)
        for form in (secret, escaped, encoded):
            self.assertNotIn(form, text, f"no copy, as {form}")
        self.assertEqual(previewed["list"], ["[hidden]", 1, None, True], "still JSON, every other value as it was")
        self.assertEqual([previewed["url"], previewed["auth"]["type"], previewed["auth"]["token"], previewed["echo"]], ["https://mcp.example.com/mcp", "bearer", "[hidden]", "token [hidden] and [hidden]"])
        self.assertEqual(sorted(previewed), sorted(["[hidden]", "auth", "echo", "list", "name", "tools", "url"]))
        self.assertIn(json.dumps(secret).encode(), server.requests[1].body, "the secret itself went to the server")
        refusal = self.thrown(client.mcp_servers.save, "refused", {"url": "https://mcp.example.com/mcp", "auth": {"type": "bearer", "token": secret}})
        assert isinstance(refusal, AgentRunRefused)
        self.assertEqual((refusal.status, refusal.code, refusal.error), (422, "input_invalid", {"code": "input_invalid"}))
        self.assertNotIn(secret, printed(refusal))
        raw = self.thrown(client.mcp_servers.save, "docs", b'{"url": "x"}')
        self.assertIsInstance(raw, AgentRunUsage, "a secret body goes as JSON only")

    def test_a_body_whose_url_reaches_a_secret_route_is_a_secret_body_too_json_only_its_values_cut(self) -> None:
        token = f"t-{secrets.token_hex(8)}"
        server = Listener(self, lambda request, reply: json_answer(200, {"echo": json.loads(request.body)}))
        client = AgentRun(base_url=server.base, api_key=KEY)
        # A home file at settings/tool-keys/k puts PUT .../settings/tool-keys/k on the wire: a tool key's save, by its URL.
        answered = client.home.write("a", "settings/tool-keys/k", {"value": token})  # type: ignore[arg-type]
        self.assertEqual(answered, {"echo": {"value": "[hidden]"}})
        self.assertEqual(server.requests[0].headers["content-type"], "application/json")
        raw = self.thrown(client.home.write, "a", "settings/tool-keys/k", token.encode())
        self.assertIsInstance(raw, AgentRunUsage)
        self.assertNotIn(token, printed(raw))
        self.assertEqual(len(server.requests), 1, "the raw body was not sent")
        self.assertEqual(client.home.write("a", "notes/k", {"value": token}), {"echo": {"value": token}}, "an ordinary route keeps its answer")  # type: ignore[arg-type]

    def test_a_get_is_tried_again_after_a_503_never_under_its_retry_after_a_post_is_not_unless_it_carries_an_idempotency_key_and_a_retry_after_past_a_minute_is_no_retry(self) -> None:
        tries = 0
        server: Listener

        def answer(request: Request, reply: Reply) -> Any:
            nonlocal tries
            tries += 1
            if request.url == "/v2/agents":
                return json_answer(503, {"error": {"code": "unavailable"}}, {"retry-after": "1"}) if tries == 1 else json_answer(200, {"agents": [], "next_cursor": None})
            if request.url == "/v2/runs":
                return json_answer(429, {"error": {"code": "rate_limited"}}, {"retry-after": "120"})
            if request.headers.get("idempotency-key") and len([r for r in server.requests if r.headers.get("idempotency-key")]) == 1:
                return json_answer(502, {"error": {"code": "bad_gateway"}})
            return json_answer(202, {"run_id": "r1", "status": "queued"}) if request.headers.get("idempotency-key") else json_answer(503, {"error": {"code": "unavailable"}})

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        began = time.monotonic()
        self.assertEqual(client.agents.list(), {"agents": [], "next_cursor": None})
        self.assertGreaterEqual(time.monotonic() - began, 1.0, "it waited the server's second")
        self.assertEqual(len(server.requests), 2)
        start = self.thrown(client.runs.start, "a", {"input": {}})
        assert isinstance(start, AgentRunRefused)
        self.assertEqual((start.status, start.code, start.retry_after), (503, "unavailable", None))
        self.assertEqual(len(server.requests), 3, "a start with no key is sent once")
        self.assertEqual(client.runs.start("a", {"input": {}}, idempotency_key="k1"), {"run_id": "r1", "status": "queued"})
        self.assertEqual(len(server.requests), 5, "with a key it is tried again")
        limited = self.thrown(client.runs.list)
        assert isinstance(limited, AgentRunRefused)
        self.assertEqual((limited.status, limited.retry_after, len(server.requests)), (429, 120.0, 6))

    def test_a_server_that_cannot_be_reached_is_named_by_its_failure_code_after_one_try_and_a_501_is_unsupported_with_its_capability(self) -> None:
        gone = self.thrown(AgentRun(base_url=f"http://127.0.0.1:{free_port()}/v2", api_key=KEY).agents.list)
        assert isinstance(gone, AgentRunUnreachable)
        self.assertEqual((gone.kind, gone.cause), ("unreachable", "ECONNREFUSED"))
        self.assertNotIn(KEY, printed(gone))
        tries: list[str] = []
        real = socket.getaddrinfo

        def lookup(host: Any, *args: Any, **kwargs: Any) -> Any:
            if host == "agentrun.invalid":
                tries.append(host)
                raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")
            return real(host, *args, **kwargs)

        with mock.patch("socket.getaddrinfo", lookup):
            unknown = self.thrown(AgentRun(base_url="http://agentrun.invalid/v2", api_key=KEY).agents.list)
        assert isinstance(unknown, AgentRunUnreachable)
        self.assertEqual((unknown.cause, len(tries)), ("ENOTFOUND", 1))
        server = Listener(self, lambda request, reply: json_answer(501, {"error": {"code": "unsupported_here", "message": "Not here.", "retryable": False, "capability": "quotes"}}))
        off = self.thrown(AgentRun(base_url=server.base, api_key=KEY).stats)
        assert isinstance(off, AgentRunUnsupported)
        self.assertEqual((off.kind, off.by, off.capability, off.status, len(server.requests)), ("unsupported", "server", "quotes", 501, 1))

    def test_runs_wait_long_polls_the_timeline_tries_a_gateways_502_again_returns_a_run_waiting_on_a_person_and_past_its_timeout_raises_with_the_run_as_it_is(self) -> None:
        asked = 0

        def answer(request: Request, reply: Reply) -> Any:
            nonlocal asked
            if request.url.startswith("/v2/runs/r1/timeline"):
                asked += 1
                return json_answer(502, {}) if asked == 1 else json_answer(200, page())
            if request.url == "/v2/runs/r1":
                return json_answer(200, {"run_id": "r1", "status": "working"})
            if request.url.startswith("/v2/runs/r2/timeline"):
                return json_answer(200, page(run_id="r2", status="input_required", unchanged=False))
            if request.url == "/v2/runs/r2":
                return json_answer(200, {"run_id": "r2", "status": "input_required", "pending": {"kind": "question"}})
            return json_answer(404, {"error": {"code": "not_found"}})

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        late = self.thrown(client.runs.wait, "r1", timeout=0.7005)
        assert isinstance(late, AgentRunTimeout)
        self.assertEqual((late.kind, late.run_id, late.run), ("late", "r1", {"run_id": "r1", "status": "working"}))
        polls = [parse_qs(urlsplit(r.url).query) for r in server.requests if r.url.startswith("/v2/runs/r1/timeline")]
        self.assertGreaterEqual(len(polls), 3, "a 502, then polls")
        self.assertEqual(polls[0]["wait_ms"], ["0"])
        for poll in polls[2:]:
            self.assertTrue(poll["wait_ms"][0].isdigit() and int(poll["wait_ms"][0]) <= 25_000, "whole milliseconds, at most the route's maximum")
        self.assertEqual(client.runs.wait("r2"), {"run_id": "r2", "status": "input_required", "pending": {"kind": "question"}})
        self.assertIsInstance(self.thrown(client.runs.wait, "r1", timeout=0), AgentRunUsage)

    def test_runs_wait_whose_deadline_passes_while_a_refusals_body_is_still_coming_ends_in_a_timeout_never_a_refusal(self) -> None:
        def answer(request: Request, reply: Reply) -> Any:
            if request.url == "/v2/runs/r1":
                return json_answer(200, {"run_id": "r1", "status": "working"})
            body = json.dumps({"error": {"code": "not_found", "message": "no"}}).encode()
            reply.head(404, {**JSON_HEADERS, "content-length": str(len(body))})
            reply.write(body[:8])
            reply.hold()
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY, max_retries=0)
        late = self.thrown(client.runs.wait, "r1", timeout=0.3)
        assert isinstance(late, AgentRunTimeout), repr(late)
        self.assertEqual((late.run_id, late.run), ("r1", {"run_id": "r1", "status": "working"}))

    def test_runs_follow_resumes_a_dropped_stream_with_last_event_id_each_page_once_waiting_at_least_the_servers_retry_and_ends_at_the_end_event(self) -> None:
        first = page(next_after=1, rows=[{"id": "a"}])
        second = page(next_after=2, rows=[{"id": "b"}], status="completed", final=True)
        at: list[float] = []

        def answer(request: Request, reply: Reply) -> Any:
            at.append(time.monotonic())
            reply.head(200, {"content-type": "text/event-stream"})
            if not request.headers.get("last-event-id"):
                reply.write(f'retry: 1200\n\nid: 1\nevent: rows\ndata: {json.dumps(first)}\n\n: keepalive\n\nid: 2\nevent: rows\ndata: {{"cut')
                reply.wait(0.02)
                reply.destroy()
                return None
            if request.url.startswith("/v2/runs/bad/"):
                reply.end("event: rows\ndata: not json\n\n")
                return None
            reply.end(f'id: 2\nevent: rows\ndata: {json.dumps(second)}\n\nevent: end\ndata: {{"reason":"terminal"}}\n\n')
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        pages = list(client.runs.follow("r1"))
        self.assertEqual(pages, [first, second])
        self.assertEqual([(r.url, r.headers.get("accept"), r.headers.get("last-event-id")) for r in server.requests], [("/v2/runs/r1/timeline", "text/event-stream", None), ("/v2/runs/r1/timeline", "text/event-stream", "1")])
        self.assertGreaterEqual(at[1] - at[0], 1.2, "the reconnect waited the server's retry")
        bad = self.thrown(lambda: list(client.runs.follow("bad", last_event_id="4")))
        assert isinstance(bad, AgentRunRefused)
        self.assertEqual((bad.kind, bad.code), ("refused", "bad_answer"))
        self.assertIsInstance(self.thrown(client.runs.follow, "r1", last_event_id="1\nx"), AgentRunUsage, "refused at the call, before any request")
        self.assertIsInstance(self.thrown(client.runs.follow, "r1", after=-1), AgentRunUsage)

    def test_a_download_comes_back_byte_for_byte_as_bytes_or_as_a_streamed_response(self) -> None:
        data = bytes(range(256))
        server = Listener(self, lambda request, reply: (200, {"content-type": "application/octet-stream"}, data))
        client = AgentRun(base_url=server.base, api_key=KEY)
        got = client.runs.read_file("r1", "data/all.bin")
        self.assertIsInstance(got, bytes)
        self.assertEqual(got, data)
        with client.home.read("a", "all.bin", stream=True) as response:
            self.assertIsInstance(response, StreamedResponse)
            self.assertEqual((response.status, response.headers.get("content-type")), (200, "application/octet-stream"))
            self.assertEqual(b"".join(response.iter_bytes(100)), data)

    def test_a_body_cut_after_a_2xx_is_tried_again_for_a_get_and_a_download_and_a_posts_is_unreachable_with_a_code(self) -> None:
        data = bytes(range(256))
        tries: dict[str, int] = {}

        def cut(reply: Reply, kind: str, whole: bytes) -> None:
            reply.head(200, {"content-type": kind, "content-length": str(len(whole))})
            reply.write(whole[: len(whole) // 2])
            reply.wait(0.02)
            reply.destroy()

        def answer(request: Request, reply: Reply) -> Any:
            n = tries[request.url] = tries.get(request.url, 0) + 1
            listed = json.dumps({"agents": [], "next_cursor": None}).encode()
            if request.url == "/v2/agents":
                return cut(reply, "application/json", listed) if n == 1 else json_answer(200, {"agents": [], "next_cursor": None})
            if request.url == "/v2/runs/r1/files/all.bin":
                return cut(reply, "application/octet-stream", data) if n == 1 else (200, {"content-type": "application/octet-stream"}, data)
            return cut(reply, "application/json", json.dumps({"run_id": "r1", "status": "queued"}).encode())

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        self.assertEqual(client.agents.list(), {"agents": [], "next_cursor": None})
        self.assertEqual(tries["/v2/agents"], 2, "the cut list was tried again")
        self.assertEqual(client.runs.read_file("r1", "all.bin"), data)
        self.assertEqual(tries["/v2/runs/r1/files/all.bin"], 2, "and the cut download")
        started = self.thrown(client.runs.start, "a", {"input": {}})
        assert isinstance(started, AgentRunUnreachable), repr(started)
        self.assertRegex(started.cause, r"^[A-Za-z0-9_]+$")
        self.assertEqual(tries["/v2/agents/a/runs"], 1, "a start with no key is sent once")
        self.assertNotIn(KEY, printed(started))
        self.assertEqual(server.requests[-1].url, "/v2/agents/a/runs")

    def test_an_mcp_sign_in_has_no_method_it_starts_in_the_owners_browser_whose_callback_needs_the_cookie_its_start_sets(self) -> None:
        client = AgentRun(base_url="https://agentrun.example.com/v2", api_key=KEY)
        self.assertFalse(hasattr(client.mcp_servers, "oauth_start"))
        self.assertTrue(callable(client.mcp_servers.oauth_client), "its public client document stays")
        self.assertNotIn("startMcpOAuth", OPERATIONS)

    def test_a_secret_bodys_list_items_are_public_by_brackets_as_the_cli_reads_them_each_item_kept_every_other_string_cut(self) -> None:
        body = json.dumps({"url": "https://mcp.example.com/mcp", "scopes": ["read", "write"], "client_id": "abc", "client_secret": "cs-1"})
        self.assertEqual(secrets_of(body, ["url", "scopes.[]", "client_id"]), ["cs-1"])
        self.assertEqual(secrets_of(body, ["url", "client_id"]), ["read", "write", "cs-1"], "without the list path, each item is a secret")
        answer = scrubber_of(secrets_of(body, ["url", "scopes.[]", "client_id"]))({"page": "https://auth.example.com/authorize?scope=read%20write", "echo": "cs-1"})
        self.assertEqual(answer, {"page": "https://auth.example.com/authorize?scope=read%20write", "echo": "[hidden]"})
        self.assertEqual(scrubber_of(["k"])({"k": 1, "[hidden]": 2}), {"[hidden]": 1, "[hidden] (2)": 2}, "two keys the cut makes one are kept apart")
        self.assertEqual(secrets_of("not json", []), ["not json"], "a body that is not JSON is one secret whole")

    def test_runs_follow_does_not_restart_a_healthy_stream_while_its_reader_is_busy_with_a_page(self) -> None:
        first = page(next_after=1, rows=[{"id": "a"}])
        second = page(next_after=2, rows=[{"id": "b"}], status="completed", final=True)

        def answer(request: Request, reply: Reply) -> Any:
            reply.head(200, {"content-type": "text/event-stream"})
            reply.write(f"id: 1\nevent: rows\ndata: {json.dumps(first)}\n\n")
            began = time.monotonic()
            while time.monotonic() - began < 1.5:
                reply.wait(0.1)
                try:
                    reply.write(": keepalive\n\n")
                except OSError:
                    return None
            reply.end(f'id: 2\nevent: rows\ndata: {json.dumps(second)}\n\nevent: end\ndata: {{"reason":"terminal"}}\n\n')
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        pages = []
        for p in client.runs.follow("r1", idle_timeout=0.4):
            pages.append(p)
            if len(pages) == 1:
                time.sleep(0.9)
        self.assertEqual(pages, [first, second])
        self.assertEqual(len(server.requests), 1, "one connection: the reader's own pause is no silence of the server's")

    def test_runs_follow_waits_out_a_gateways_retry_after_before_it_reconnects(self) -> None:
        done = page(status="completed", final=True)
        at: list[float] = []

        def answer(request: Request, reply: Reply) -> Any:
            at.append(time.monotonic())
            if len(at) == 1:
                return json_answer(503, {"error": {"code": "unavailable"}}, {"retry-after": "1"})
            reply.head(200, {"content-type": "text/event-stream"})
            reply.end(f'id: 1\nevent: rows\ndata: {json.dumps(done)}\n\nevent: end\ndata: {{"reason":"terminal"}}\n\n')
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        self.assertEqual(list(client.runs.follow("r1")), [done])
        self.assertGreaterEqual(at[1] - at[0], 1.0, f"it waited the gateway's second: {at[1] - at[0]} s")

    def test_a_per_call_timeout_while_a_refusals_body_is_still_coming_keeps_its_status_and_no_error_object_never_a_wrong_code(self) -> None:
        def answer(request: Request, reply: Reply) -> Any:
            status = 400 if request.url == "/v2/agents" else 401
            body = json.dumps({"error": {"code": "bad_request" if status == 400 else "unauthorized", "message": "no"}}).encode()
            reply.head(status, {**JSON_HEADERS, "content-length": str(len(body))})
            reply.write(body[:8])
            reply.hold()
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY, max_retries=0)
        refused = self.thrown(client.agents.list, timeout=0.3)
        assert isinstance(refused, AgentRunRefused), repr(refused)
        self.assertEqual((refused.status, refused.code, refused.error), (400, None, None))
        denied = self.thrown(client.agents.get, "a", timeout=0.3)
        assert isinstance(denied, AgentRunAuthError), repr(denied)
        self.assertEqual((denied.status, denied.code, denied.error), (401, None, None))

    def test_a_fresh_clients_first_get_is_tried_again_when_the_server_takes_the_connection_and_drops_it_before_answering(self) -> None:
        tries = 0

        def answer(request: Request, reply: Reply) -> Any:
            nonlocal tries
            tries += 1
            if tries == 1:
                reply.destroy()
                return None
            return json_answer(200, {"agents": [], "next_cursor": None})

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        self.assertEqual(client.agents.list(), {"agents": [], "next_cursor": None})
        self.assertEqual(tries, 2, "the dropped first request was tried once more")

    def test_a_certificate_the_client_refuses_is_unreachable_after_one_try(self) -> None:
        openssl = shutil.which("openssl")
        if openssl is None:
            self.skipTest("no openssl to make a self-signed certificate with")
        folder = tempfile.mkdtemp(prefix="agentrun-python-tls-")
        self.addCleanup(shutil.rmtree, folder, True)
        cert, key = os.path.join(folder, "cert"), os.path.join(folder, "key")
        subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", key, "-out", cert], check=True, capture_output=True, timeout=60)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        listening = socket.socket()
        listening.bind(("127.0.0.1", 0))
        listening.listen(8)
        self.addCleanup(listening.close)
        accepted: list[int] = []

        def serve() -> None:
            while True:
                try:
                    connection, _ = listening.accept()
                except OSError:
                    return
                accepted.append(1)
                try:
                    context.wrap_socket(connection, server_side=True).close()
                except (OSError, ssl.SSLError):
                    connection.close()

        threading.Thread(target=serve, daemon=True).start()
        refused = self.thrown(AgentRun(base_url=f"https://localhost:{listening.getsockname()[1]}/v2", api_key=KEY).agents.list)
        assert isinstance(refused, AgentRunUnreachable), repr(refused)
        self.assertRegex(refused.cause, r"CERT")
        self.assertEqual(len(accepted), 1, "one try")

    def test_a_refusal_whose_code_echoes_a_secret_bodys_value_keeps_no_code_in_the_error_or_its_message(self) -> None:
        secret = f"secret_{secrets.token_hex(8)}"
        server = Listener(self, lambda request, reply: json_answer(401 if request.url.endswith("/auth") else 422, {"error": {"code": secret, "message": "no"}}))
        client = AgentRun(base_url=server.base, api_key=KEY)
        refused = self.thrown(client.mcp_servers.save, "docs", {"url": "https://mcp.example.com/mcp", "auth": {"type": "bearer", "token": secret}})
        assert isinstance(refused, AgentRunRefused)
        self.assertEqual((refused.status, refused.code, refused.error), (422, None, None))
        self.assertNotIn(secret, printed(refused))
        auth = self.thrown(client.mcp_servers.save, "auth", {"url": "https://mcp.example.com/mcp", "auth": {"type": "bearer", "token": secret}})
        assert isinstance(auth, AgentRunAuthError)
        self.assertIsNone(auth.code)
        self.assertNotIn(secret, printed(auth))

    def test_a_timeout_is_not_tried_again(self) -> None:
        def answer(request: Request, reply: Reply) -> Any:
            reply.hold()
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        began = time.monotonic()
        late = self.thrown(client.agents.list, timeout=0.3)
        assert isinstance(late, AgentRunUnreachable), repr(late)
        self.assertEqual((late.cause, len(server.requests)), ("timeout", 1))
        self.assertLess(time.monotonic() - began, 2.0)
        self.assertIsInstance(self.thrown(client.agents.list, timeout=0), AgentRunUsage)

    def test_a_try_ends_at_its_timeout_even_while_its_body_trickles_in_and_a_body_with_no_length_is_then_a_timeout_never_a_short_answer(self) -> None:
        def answer(request: Request, reply: Reply) -> Any:
            reply.head(200, {"content-type": "application/octet-stream"})
            for _ in range(100):
                try:
                    reply.write(b"x")
                except OSError:
                    return None
                reply.wait(0.05)
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        began = time.monotonic()
        late = self.thrown(client.runs.read_file, "r1", "all.bin", timeout=0.3)
        assert isinstance(late, AgentRunUnreachable), repr(late)
        self.assertEqual((late.cause, len(server.requests)), ("timeout", 1))
        self.assertLess(time.monotonic() - began, 2.0, "the try's whole time, not each read's")

    def test_an_answer_with_an_etag_comes_back_tagged_with_it(self) -> None:
        server = Listener(self, lambda request, reply: json_answer(200, {"agent_id": "a"}, {"etag": '"v1"'}))
        client = AgentRun(base_url=server.base, api_key=KEY)
        got = client.agents.get("a")
        self.assertIsInstance(got, Tagged)
        self.assertEqual((got.body, got.etag), ({"agent_id": "a"}, '"v1"'))
        with self.assertRaises(AttributeError):
            got.etag = "x"  # type: ignore[misc]

    def test_query_parameters_go_as_the_server_reads_them_and_a_raw_body_with_its_type(self) -> None:
        server = Listener(self, lambda request, reply: json_answer(200, {"runs": [], "next_cursor": None, "ok": True}))
        client = AgentRun(base_url=server.base, api_key=KEY)
        client.runs.list(limit=10, archived=True, status="completed", agent="a b")
        client.files.upload("f1", b"\x89PNG", body_type="image/png")
        client.learning.write("notes", "policies.md", "# Policies\n", if_none_match="*", body_type="text/markdown")
        first, upload, note = server.requests
        self.assertEqual(urlsplit(first.url).query, "limit=10&agent=a+b&status=completed&archived=true")
        self.assertEqual((upload.method, upload.headers["content-type"], upload.body), ("PUT", "image/png", b"\x89PNG"))
        self.assertEqual((note.headers["content-type"], note.headers["if-none-match"], note.body), ("text/markdown", "*", b"# Policies\n"))

    def test_the_key_is_in_no_traceback_even_one_that_prints_its_locals(self) -> None:
        elsewhere = Listener(self)
        home = Listener(self, lambda request, reply: (302, {"location": f"{elsewhere.base}/agents"}, ""))
        away = self.thrown(AgentRun(base_url=home.base, api_key=KEY).agents.list)
        self.assertIsInstance(away, AgentRunRefused)
        with mock.patch.dict(os.environ, {"AGENTRUN_BASE_URL": home.base, "AGENTRUN_API_KEY": f"{KEY}\n"}):
            bad = self.thrown(AgentRun)
        with mock.patch.dict(os.environ, {"AGENTRUN_BASE_URL": home.base, "AGENTRUN_API_KEY": KEY}):
            zero = self.thrown(AgentRun, timeout=0)
        given = self.thrown(AgentRun, base_url=home.base, api_key=f"{KEY}\n")
        for error in (away, bad, zero, given):
            self.assertIsInstance(error, AgentRunError)
            rendered = traceback.TracebackException.from_exception(error, capture_locals=True)
            # The client's own frames: the test's frames hold the key it passed, as any caller's would.
            frames = [frame for frame in rendered.stack if os.path.abspath(frame.filename).startswith(PACKAGE)]
            self.assertTrue(frames, "the error came from inside the client")
            self.assertNotIn(KEY, "".join(traceback.StackSummary.from_list(frames).format()) + "".join(rendered.format_exception_only()))

    def test_a_retry_after_that_is_not_digits_or_a_date_is_no_retry_after_and_never_breaks_an_answer(self) -> None:
        tries: dict[str, int] = {}

        def answer(request: Request, reply: Reply) -> Any:
            n = tries[request.url] = tries.get(request.url, 0) + 1
            if request.url == "/v2/agents":
                return json_answer(200, {"agents": [], "next_cursor": None}, {"retry-after": "\u00b2"})
            return json_answer(503, {"error": {"code": "unavailable"}}, {"retry-after": "\u00b9"}) if n == 1 else json_answer(200, {"runs": [], "next_cursor": None})

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        self.assertEqual(client.agents.list(), {"agents": [], "next_cursor": None})
        self.assertEqual(client.runs.list(), {"runs": [], "next_cursor": None})
        self.assertEqual(tries["/v2/runs"], 2)

    def test_a_try_that_hits_its_own_timeout_in_the_handshake_is_a_timeout_and_is_not_tried_again(self) -> None:
        listening = socket.socket()
        listening.bind(("127.0.0.1", 0))
        listening.listen(8)
        self.addCleanup(listening.close)
        held: list[socket.socket] = []

        def accept() -> None:
            while True:
                try:
                    held.append(listening.accept()[0])
                except OSError:
                    return

        threading.Thread(target=accept, daemon=True).start()
        self.addCleanup(lambda: [connection.close() for connection in held])
        client = AgentRun(base_url=f"https://127.0.0.1:{listening.getsockname()[1]}/v2", api_key=KEY)
        client._reached = True  # a client that has reached its server before
        stalled = self.thrown(client.agents.list, timeout=0.3)
        assert isinstance(stalled, AgentRunUnreachable), repr(stalled)
        self.assertEqual((stalled.cause, len(held)), ("timeout", 1))

    def test_a_slow_connect_and_a_stalled_handshake_share_the_tries_one_timeout(self) -> None:
        listening = socket.socket()
        listening.bind(("127.0.0.1", 0))
        listening.listen(8)
        self.addCleanup(listening.close)
        held: list[socket.socket] = []

        def accept() -> None:
            while True:
                try:
                    held.append(listening.accept()[0])
                except OSError:
                    return

        threading.Thread(target=accept, daemon=True).start()
        self.addCleanup(lambda: [connection.close() for connection in held])
        real = socket.socket.connect
        slowed: list[Any] = []

        def slow(sock: socket.socket, address: Any) -> None:
            slowed.append(address)
            time.sleep(0.3)  # a connect that takes most of the try's time
            real(sock, address)

        client = AgentRun(base_url=f"https://127.0.0.1:{listening.getsockname()[1]}/v2", api_key=KEY)
        began = time.monotonic()
        with mock.patch.object(socket.socket, "connect", slow):
            stalled = self.thrown(client.agents.list, timeout=0.5)
        took = time.monotonic() - began
        assert isinstance(stalled, AgentRunUnreachable), repr(stalled)
        self.assertEqual(len(slowed), 1, "the slow connect is the one the client makes")
        self.assertEqual((stalled.cause, len(held)), ("timeout", 1))
        self.assertLess(took, 0.5 + 0.15, "the handshake had what the connect left of the try, not a timeout of its own")

    def test_a_resolver_that_stalls_ends_the_try_at_its_timeout_as_a_timeout_after_one_try(self) -> None:
        asked: list[str] = []

        def stall(host: Any, *args: Any, **kwargs: Any) -> Any:
            asked.append(str(host))
            time.sleep(2.0)
            return []

        client = AgentRun(base_url="http://agentrun.example/v2", api_key=KEY)
        began = time.monotonic()
        with mock.patch("socket.getaddrinfo", stall):
            stalled = self.thrown(client.agents.list, timeout=0.3)
        took = time.monotonic() - began
        assert isinstance(stalled, AgentRunUnreachable), repr(stalled)
        self.assertEqual((stalled.cause, asked), ("timeout", ["agentrun.example"]))
        self.assertLess(took, 0.3 + 0.15, "the lookup is on the try's clock")

    def test_several_addresses_that_never_answer_share_the_tries_one_timeout(self) -> None:
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.1", 80)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.2", 80))]
        tried: list[Any] = []

        def blackhole(sock: socket.socket, address: Any) -> None:
            tried.append(address)
            time.sleep(sock.gettimeout() or 0)
            raise socket.timeout("timed out")

        client = AgentRun(base_url="http://agentrun.example/v2", api_key=KEY)
        began = time.monotonic()
        with mock.patch("socket.getaddrinfo", lambda *args, **kwargs: addresses), mock.patch.object(socket.socket, "connect", blackhole):
            stalled = self.thrown(client.agents.list, timeout=0.3)
        took = time.monotonic() - began
        assert isinstance(stalled, AgentRunUnreachable), repr(stalled)
        self.assertEqual(stalled.cause, "timeout")
        self.assertEqual(tried[:1], [("192.0.2.1", 80)], "the client's connect is the one patched")
        self.assertLess(took, 0.3 + 0.15, f"every address on the try's one clock, {len(tried)} tried")

    def test_an_address_whose_family_the_host_cannot_make_is_passed_over_for_the_next_one(self) -> None:
        server = Listener(self, lambda request, reply: json_answer(200, {"agents": [], "next_cursor": None}))
        port = int(server.origin.rsplit(":", 1)[1])
        addresses = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port, 0, 0)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
        real = socket.socket
        refused: list[int] = []

        def make(*args: Any, **kwargs: Any) -> socket.socket:
            family = args[0] if args else kwargs.get("family")
            if family == socket.AF_INET6 and "fileno" not in kwargs:
                refused.append(family)
                raise OSError(errno.EAFNOSUPPORT, "Address family not supported by protocol")
            return real(*args, **kwargs)

        client = AgentRun(base_url=f"http://agentrun.example:{port}{server.prefix}/v2", api_key=KEY)
        with mock.patch("socket.getaddrinfo", lambda *args, **kwargs: addresses), mock.patch("socket.socket", make):
            self.assertEqual(client.agents.list(), {"agents": [], "next_cursor": None})
        self.assertEqual((refused, len(server.requests)), ([socket.AF_INET6], 1))

    def test_a_url_python_cannot_parse_is_a_usage_error_as_a_base_url_and_a_refused_redirect_as_a_location(self) -> None:
        self.assertIsInstance(self.thrown(AgentRun, base_url="http://[::1/v2", api_key=KEY), AgentRunUsage)
        elsewhere = Listener(self)
        server = Listener(self, lambda request, reply: (302, {"location": "http://[::1/x"}, ""))
        refused = self.thrown(AgentRun(base_url=server.base, api_key=KEY).agents.list)
        assert isinstance(refused, AgentRunRefused), repr(refused)
        self.assertEqual((refused.status, refused.code), (302, "redirect"))
        self.assertEqual((len(server.requests), elsewhere.requests), (1, []))
        self.assertNotIn(KEY, printed(refused))

    def test_nothing_but_an_agentrun_error_escapes_a_host_idna_refuses_is_a_usage_error_and_a_lone_surrogate_in_a_query_is_sent_as_u_fffd(self) -> None:
        self.assertIsInstance(self.thrown(AgentRun, base_url=f"http://{'a' * 64}.example/v2", api_key=KEY), AgentRunUsage)
        server = Listener(self, lambda request, reply: json_answer(200, {"agents": [], "next_cursor": None}))
        AgentRun(base_url=server.base, api_key=KEY).agents.list(cursor="a\ud800b")
        self.assertEqual(parse_qs(urlsplit(server.requests[0].url).query)["cursor"], ["a\ufffdb"])

    def test_runs_follow_waits_at_most_a_minute_whatever_retry_the_server_names(self) -> None:
        done = page(status="completed", final=True)

        def answer(request: Request, reply: Reply) -> Any:
            reply.head(200, {"content-type": "text/event-stream"})
            if not request.headers.get("last-event-id"):
                reply.end('retry: 99999999999999999\n\nid: 1\nevent: end\ndata: {"reason":"reconnect"}\n\n')
            else:
                reply.end(f'id: 2\nevent: rows\ndata: {json.dumps(done)}\n\nevent: end\ndata: {{"reason":"terminal"}}\n\n')
            return None

        server = Listener(self, answer)
        client = AgentRun(base_url=server.base, api_key=KEY)
        waits: list[float] = []
        with mock.patch("agentrun._live.pause", waits.append):
            self.assertEqual(list(client.runs.follow("r1")), [done])
        self.assertEqual(waits, [60.0])

    def test_runs_follow_reads_a_stream_that_begins_with_a_byte_order_mark(self) -> None:
        done = page(status="completed", final=True)

        def answer(request: Request, reply: Reply) -> Any:
            reply.head(200, {"content-type": "text/event-stream"})
            reply.end(f'\ufeffevent: rows\ndata: {json.dumps(done)}\n\nevent: end\ndata: {{"reason":"terminal"}}\n\n'.encode())
            return None

        server = Listener(self, answer)
        self.assertEqual(list(AgentRun(base_url=server.base, api_key=KEY).runs.follow("r1")), [done])

    def test_every_error_class_survives_a_pickle_round_trip(self) -> None:
        errors: list[AgentRunError] = [
            AgentRunRefused("GET /agents", 503, "unavailable", {"code": "unavailable"}, None, 2.0),
            AgentRunAuthError("refused", "The server refused the API key for GET /agents: 401.", 401, "unauthorized", {"code": "unauthorized"}),
            AgentRunUnsupported("GET /stats", 501, "unsupported_here", {"capability": "quotes"}),
            AgentRunUnreachable("http://127.0.0.1:1/v2", "ECONNREFUSED"),
            AgentRunUsage("runId must be a string that is not empty."),
            AgentRunTimeout("r1", 1.5, None),
        ]
        for error in errors:
            back = pickle.loads(pickle.dumps(error))
            self.assertIs(type(back), type(error))
            self.assertEqual((str(back), vars(back)), (str(error), vars(error)))


if __name__ == "__main__":
    unittest.main()
