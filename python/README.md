# parcha-agentrun

A typed Python client for an AgentRun server you host yourself, the open platform's server: one method per operation of
its API, typed from the OpenAPI document it serves, plus waiting for a run and following its timeline. It is synchronous
and uses the standard library only (`http.client`, `json`, `ssl`), on Python 3.10 or newer.

## Install

The package is held in this repository: it is not on PyPI. Install it from GitHub, or from a checkout:

```sh
pip install "git+https://github.com/Parcha-ai/agentrun#subdirectory=python"
pip install ./python
```

It installs as `parcha-agentrun` and imports as `agentrun`. It has no dependencies, and it ships `py.typed`, so pyright
and mypy read its types.

## Construct

```python
import os

from agentrun import AgentRun

client = AgentRun(base_url="https://agentrun.example.com/v2", api_key=os.environ["AGENTRUN_API_KEY"])
```

`base_url` defaults to `AGENTRUN_BASE_URL` and `api_key` to `AGENTRUN_API_KEY`. The base URL must be http or https with
no query, fragment, user, password, space or `.` or `..` segment, and the key must be a valid header value; both are
checked here, before any request. The client reads no file: finding the server started on this machine (its data
directory and the address it records there) is the CLI's job (`npx @parcha/agentrun`), not this package's. It reads no
proxy from the environment either: the key goes to the base URL's origin and nowhere else. Other arguments: `timeout`,
how long one try of a request may take in seconds, its answer read included (default 60), and `max_retries` (default 4).

Methods are grouped as the CLI's commands are, in snake_case: `agents create` is `client.agents.create(body)`,
`runs start AGENT` is `client.runs.start(agent_id, body)`, `mcp-servers save NAME` is
`client.mcp_servers.save(name, body)`. Path parameters and the body come first, by position; query and header
parameters are keyword arguments named in snake_case (`limit=`, `cursor=`, `idempotency_key=`, `if_match=`, and
`from_=` for `from`); every method takes `timeout=` too. Bodies and answers are `TypedDict`s, enums are `Literal`s, all
importable from `agentrun` (`Run`, `TimelinePage`, `CreateRunBody`, ...). An operation whose answer carries an ETag
(`agents.get`, `agents.update`, `learning.read`, `learning.write`) returns `Tagged(body, etag)`: pass `etag` as the next
write's `if_match=`. A body the operation also takes as bytes or text (a file upload, a learning note) is sent as given,
with `body_type=` as its content type.

## Examples

Create an agent, start a run with a spend cap and wait for it:

```python
client.agents.create({"definition": {"id": "notes", "version": 1, "name": "Notes", "instructions": "Write what you are asked to a file.", "skills": [], "tools": ["write", "ask_person"]}})
started = client.runs.start("notes", {"input": {"content": "Write notes.md about the Moon."}, "max_cost_usd": 0.5})
run = client.runs.wait(started["run_id"], timeout=120)
print(run["status"], run["cost"]["usd"])
```

`runs.wait` returns once the run ends (`completed`, `failed`, `cancelled`) or waits on a person (`input_required`,
`paused`). Answer a question, or raise the cap of a run stopped at it, then wait again:

```python
pending = run.get("pending")
if pending and pending["kind"] == "question":
    client.runs.message(run["run_id"], {"content": "Europe"})
if pending and pending["kind"] == "budget":
    client.runs.raise_cap(run["run_id"], {"max_cost_usd": 1})
done = client.runs.wait(run["run_id"])
```

Follow the timeline as it changes, then read a file the run wrote:

```python
for page in client.runs.follow(done["run_id"]):
    for row in page["rows"]:
        print(row["kind"])
data = client.runs.read_file(done["run_id"], "notes.md")  # bytes, byte for byte
with client.runs.read_file(done["run_id"], "notes.md", stream=True) as response:  # a StreamedResponse, unread
    for chunk in response.iter_bytes():
        ...
```

`runs.follow` reads the route's event stream and resumes a dropped connection with `Last-Event-ID`, so no page comes
twice. It waits at least the server's `retry` before it reconnects, and a gateway's `Retry-After`. Only the server's
silence counts as a dropped connection (`idle_timeout=`, default 45 seconds), never the time your loop spends on a page.
Its arguments are checked when you call it, before anything is sent.

## Errors

Every error is an `AgentRunError`, and its `kind` says which one:

| Class | `kind` | When | Fields |
|---|---|---|---|
| `AgentRunRefused` | `refused` | The server refused (4xx, 5xx); a redirect away from the base URL's origin, or one this client does not follow (`code` `redirect`); an answer the client cannot read (`code` `bad_answer`) | `status`, `code`, `error` (the server's error object), `retry_after` (seconds) |
| `AgentRunAuthError` | `auth` | No key (`reason` `no_token`), a key that is not a valid header value (`bad_header`), or a key the server refused, 401 or 403 (`refused`) | `reason`, `status`, `code`, `error` |
| `AgentRunUnsupported` | `unsupported` | The server does not offer the operation here (501) | `capability`, `status`, `code`, `error` |
| `AgentRunUnreachable` | `unreachable` | No answer: the server is down, the connection dropped, or a try timed out | `cause`, the failure's code (`ECONNREFUSED`, `ENOTFOUND`, `timeout`, `CERT_...`) |
| `AgentRunUsage` | `usage` | A bad argument, before anything was sent: a path argument with a `.` or `..` segment, a header value with a line break, a timeout of 0 | `reason` |
| `AgentRunTimeout` | `late` | `runs.wait` passed its `timeout`; the run goes on | `run_id`, `run` as last read |

No message holds the API key or the server's own message text: a message names the route, the status and the server's
error code. No printed form of an error or of the client holds the key: not `str()`, `repr()`, a traceback, nor
`vars()`, and the client does not pickle it. The key is cut from the server's error object.

## Secret bodies

A secret body (a tool key, an MCP server's credentials: `tool_keys.save`, `mcp_servers.save`, `mcp_servers.preview`)
goes as JSON only, and each of its string values is cut from the answer as a JSON value (as it is, JSON-escaped and
URL-encoded), its structure and public fields (`url`, `auth.type`) kept, with `[hidden]` in its place. A refusal of it
keeps only its code, and a code that held one of its values is no code. A body whose URL reaches a secret route, the base
URL's own path counted, is a secret body too.

## Retries and redirects

A GET, or a request that carries an `Idempotency-Key`, is tried again after a 429, a 5xx or a dropped connection (a body
cut midway included), with backoff and never sooner than the server's `Retry-After`; a `Retry-After` over a minute is no
retry. Any other request is sent once. A fresh client's first request ends at once only when no connection was made
(refused, unknown name, unreachable host); a connection dropped after it was made is tried again even then. A
certificate the client refuses is never tried again, and neither is a try that ran out of its time, whether it was
connecting, in its TLS handshake or reading. A redirect is followed only for a
GET within the base URL's origin, up to 5 hops: the key never goes to another server.

## Cancellation

Python has no `AbortSignal`, and this client is synchronous: a timeout is the way to bound a call. The client's
`timeout`, or a method's own `timeout=`, ends one try at that many seconds, its answer read included, whatever the
server does; past it the call raises `AgentRunUnreachable` with `cause` `timeout` (or, when the answer's head had come,
the refusal it carried). `runs.wait(run_id, timeout=...)` bounds the whole wait, and a read that stalls past it is
`AgentRunTimeout`, never a refusal. `runs.follow` ends when you stop iterating it (`break`, or closing the generator),
and its stream counts as dropped after `idle_timeout` of silence. Close a `StreamedResponse` you stop reading, or read it
in a `with` block.

## Where it comes from

The methods and types in `agentrun/_generated.py` are generated from the server's OpenAPI document by
`node scripts/generate-clients.mjs`, from the same projection and resource map as the CLI's commands and the TypeScript
client (`@parcha/agentrun-client`), under the same hash; `--check` fails on a stale file. The rest is hand-written and
keeps the TypeScript client's rules, test for test: `python3 -m unittest discover -s python/tests -v` runs them against
loopback servers and against the real server with a faux model (skipped when `packages/serve/dist` is not built), and
`npx pyright -p python` checks the types.
