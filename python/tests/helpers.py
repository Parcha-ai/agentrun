"""What the client's tests share: the server started with a faux model on loopback, and a loopback listener that plays a
server, each under its own random path prefix, as packages/client/test/helpers.mjs has them."""

from __future__ import annotations

import base64
import json
import os
import pickle
import pprint
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unittest
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional, Union

PYTHON = Path(__file__).resolve().parents[1]
if str(PYTHON) not in sys.path:
    sys.path.insert(0, str(PYTHON))
ROOT = PYTHON.parent
SERVE = ROOT / "packages" / "serve" / "dist" / "cli.js"
DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES", "PARALLEL_API_KEY"]

KEY = f"test-key-{secrets.token_hex(12)}"
JSON_HEADERS = {"content-type": "application/json"}

# Writes the file the first message names (`write NAME.md`); asks its person first when told to ask, and writes what
# they said; then answers. Priced on output only, $100 a million, as the server's cap tests price it.
FAUX = r"""const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default (context, faux) => {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const wrote = context.messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "toolCall" && c.name === "write"));
  if (wrote) return faux.message("Done.");
  if (users[0].includes("Ask me") && users.length === 1 && context.messages.at(-1)?.role !== "toolResult") return faux.message(faux.toolCall("ask_person", { question: "Which region?" }), { stopReason: "toolUse" });
  const file = /write (\S+\.md)/i.exec(users[0])?.[1] ?? "out.md";
  return faux.message(faux.toolCall("write", { path: file, content: "# " + users.at(-1) + "\n" }), { stopReason: "toolUse" });
};
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
"""


def json_answer(status: int, value: Any, headers: Optional[dict[str, str]] = None) -> tuple[int, dict[str, str], bytes]:
    return status, {**JSON_HEADERS, **(headers or {})}, json.dumps(value).encode()


def printed(value: Any) -> str:
    """Everything a caller could print of an error or a client."""
    parts = [str(value), repr(value), pprint.pformat(getattr(value, "__dict__", {}), depth=8)]
    if isinstance(value, BaseException):
        parts += ["".join(traceback.format_exception(value)), repr(value.args)]
    try:
        parts.append(repr(pickle.dumps(value)))
    except Exception:  # noqa: BLE001 - a value that will not pickle prints nothing that way
        pass
    return "\n".join(parts)


@dataclass
class Request:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes


class Reply:
    """The answer a listener's function writes itself: a head, some of a body, a dropped connection, or a hold."""

    def __init__(self, handler: BaseHTTPRequestHandler, closed: threading.Event) -> None:
        self._handler = handler
        self._closed = closed

    def head(self, status: int, headers: dict[str, str]) -> None:
        self._handler.send_response_only(status)
        for name, value in headers.items():
            self._handler.send_header(name, value)
        self._handler.end_headers()
        self._handler.wfile.flush()

    def write(self, data: Union[bytes, str]) -> None:
        self._handler.wfile.write(data.encode() if isinstance(data, str) else data)
        self._handler.wfile.flush()

    def end(self, data: Union[bytes, str] = b"") -> None:
        self.write(data)
        self._handler.close_connection = True

    def destroy(self) -> None:
        """Drops the connection: no more bytes, no clean end."""
        self._handler.close_connection = True
        try:
            self._handler.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def hold(self) -> None:
        """Keeps the connection open, silent, until the listener closes."""
        self._closed.wait()

    def wait(self, seconds: float) -> None:
        self._closed.wait(seconds)


Answer = Callable[[Request, Reply], Optional[tuple[int, dict[str, str], Union[bytes, str]]]]


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: Any, client_address: Any) -> None:  # a dropped connection is a test's own doing
        pass


class Listener:
    """A loopback HTTP server that records every request under its own random path prefix (part of `base`; a request's
    `url` is recorded without it) and answers with `answer(request, reply)`: (status, headers, body), or None once it
    wrote the answer itself. Anything else is a 404, neither answered nor recorded."""

    def __init__(self, test: unittest.TestCase, answer: Optional[Answer] = None) -> None:
        self.requests: list[Request] = []
        self.prefix = f"/{secrets.token_hex(8)}"
        closed = threading.Event()
        listener = self
        given = answer or (lambda request, reply: (200, JSON_HEADERS, b"{}"))

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass

            def handle_one_request(self) -> None:
                try:
                    super().handle_one_request()
                except OSError:
                    self.close_connection = True

            def _any(self) -> None:
                if not self.path.startswith(f"{listener.prefix}/"):
                    self.send_response(404)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                request = Request(self.command, self.path[len(listener.prefix):], {k.lower(): v for k, v in self.headers.items()}, body)
                listener.requests.append(request)
                answered = given(request, Reply(self, closed))
                if answered is not None:
                    status, headers, data = answered
                    raw = data.encode() if isinstance(data, str) else data
                    self.send_response_only(status)
                    for name, value in headers.items():
                        self.send_header(name, value)
                    if not any(name.lower() == "content-length" for name in headers):
                        self.send_header("content-length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _any

        self._server = _Server(("127.0.0.1", 0), Handler)
        self._closed = closed
        thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        test.addCleanup(self.close)
        self.origin = f"http://127.0.0.1:{self._server.server_address[1]}"
        self.base = f"{self.origin}{self.prefix}/v2"

    def close(self) -> None:
        self._closed.set()
        self._server.shutdown()
        self._server.server_close()


def free_port() -> int:
    """A loopback port no server holds: a connection to it is refused."""
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def node() -> Optional[str]:
    """A Node.js of 22 or newer, or None."""
    found = shutil.which("node")
    if not found:
        return None
    try:
        version = subprocess.run([found, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return found if version.startswith("v") and int(version[1:].split(".")[0]) >= 22 else None


def serve_skip_reason() -> Optional[str]:
    """Why the real server cannot start here, or None. AGENTRUN_PYTHON_REQUIRE_SERVER=1 (as CI sets) makes it a failure."""
    if not SERVE.exists():
        return f"the server is not built ({SERVE.relative_to(ROOT)} is missing): run npm run build"
    if node() is None:
        return "no Node.js 22 or newer on the PATH to start the server with"
    return None


@dataclass
class Served:
    base_url: str
    token: str


def serve(test: unittest.TestCase) -> Served:
    """The server on loopback with the priced faux model: its base URL and its token."""
    folder = tempfile.mkdtemp(prefix="agentrun-python-")
    test.addCleanup(shutil.rmtree, folder, True)
    env = {name: value for name, value in os.environ.items() if name not in DROPPED}
    env.update(HOME=folder, XDG_CONFIG_HOME=os.path.join(folder, ".config"), AGENTRUN_ACCOUNTS="0", AGENTRUN_SEAL_KEY=base64.b64encode(os.urandom(32)).decode())
    Path(folder, "faux.mjs").write_text(FAUX)
    data = Path(folder, "data")
    runner = node()
    assert runner is not None
    # The server's own log goes to a file: a pipe nobody reads would fill and stop it.
    log = open(Path(folder, "serve.log"), "wb")  # noqa: SIM115 - closed by the cleanup below
    child = subprocess.Popen([runner, str(SERVE), "--data", str(data), "--port", "0", "--faux", str(Path(folder, "faux.mjs"))], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, env=env)

    def stop() -> None:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=30)
        log.close()

    test.addCleanup(stop)
    began = time.monotonic()
    while not (data / ".server.json").exists():
        if child.poll() is not None or time.monotonic() - began > 60:
            raise AssertionError(f"the server did not start: {Path(folder, 'serve.log').read_text(errors='replace')}")
        time.sleep(0.1)
    record = json.loads((data / ".server.json").read_text())
    return Served(record["base_url"], (data / ".token").read_text().strip())
