# @parcha/agentrun-import

Reads the coding-agent sessions under a home (Claude Code, Codex, pi, OpenCode) into one Session shape: normalized token
usage, subagents counted under their parent, and cursors so a second pass reads only what changed. AgentRun's server
imports past sessions through it.

## Totals for a home

```js
import { parseHome } from "@parcha/agentrun-import";

const sessions = await parseHome(homedir(), { sources: ["claude-code", "codex"] });
// [{ key, file, source, id, tokens: { input, output, cacheRead, cacheWrite, cacheWrite1h }, reasoning, cost, turns, calls, subagents }]
```

- `key` is the sha256 (hex) of the session's file path relative to the home, `"/"` between its parts, with `#<id>` after
  it for a file that holds many sessions (an OpenCode database: `.local/share/opencode/opencode.db#ses_…`). Lines come
  sorted by key.
- `tokens.input` is the input neither read from nor written to the cache, for every source (see `normalizeUsage`).
- `cost` is USD: the source's own when it wrote one (Claude Code's `cost-state`, pi's and OpenCode's per-request cost,
  an OpenCode subagent's added to its parent's), else the requests at pi-ai's list prices (an optional peer), else `null`.
- `turns` counts the person's messages; `calls` the model requests, its subagents' with them, each once.
- `state: {}` handed to each call keeps cursors between calls: the second call reads only the bytes appended since, and
  returns what a fresh call would. When a file holding a copied record now comes before the file it counts in (an append
  moved the original after its resumed copy, or a new file sorts before one it shares records with), that source is read
  again from the start.
- `failures: []` collects each file its reader could not read (`{ key, file, source, error }`; an OpenCode database
  that does not open, for each session it lists or as itself when it lists none) while the rest are totalled; without
  it, parseHome throws `ReadFailures`. An unreadable file is never taken for an empty one.
- `env` names where a source keeps its own directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, OpenCode's `XDG_DATA_HOME` and
  `OPENCODE_DB`); without it the home's.
- A request two sources wrote is counted once. OpenCode's claude-agent provider runs Claude Code, which writes each
  request into its own session file too; OpenCode names that session on the request (`mirrors`). When the same call
  reads that Claude Code session (serve's import: or its store holds it), the request counts there and not in the OpenCode session (tokens, calls and cost),
  request by request: one OpenCode session can mix claude-agent requests with other providers'. When it does not, the
  request counts in OpenCode's.

## Known answer

```sh
node dist/cli.js <home> [--sources claude-code,codex,pi,opencode] --known-answer
```

One JSONL line per session, sorted by key: `{key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h},
cost, turns, calls}`. Numbers only: no content, title, directory or path is printed. `--help` (`-h`) prints the usage
and exits 0; a bad argument exits 2. A file that cannot be read prints no answer: one stderr line per such file
(`agentrun-import: cannot read <source> <key> (<code>)`) and exit 1. The CLI imports pi-ai statically for its prices:
a bundle (`bun build --compile`) carries it, prints the same bytes as under Node, and a build or run without pi-ai
fails instead of pricing nothing. The library keeps pi-ai an optional peer.

## Usage

`normalizeUsage(format, raw)` reads one request's usage as `"anthropic"`, `"openai"`, `"pi"` or `"opencode"` writes it:

| Source | `input` | `cacheWrite1h` | `reasoning` |
| --- | --- | --- | --- |
| Anthropic | `input_tokens` (already excludes the cache) | `cache_creation.ephemeral_1h_input_tokens` | |
| OpenAI, Codex | `input_tokens - cached_input_tokens` | | `reasoning_output_tokens` (part of `output`) |
| pi | `input` | `cacheWrite1h` | |
| OpenCode | `input` (already excludes the cache; `cache.read`, `cache.write`) | | `reasoning`, added to `output` |

A Claude Code session's id is its file's name (`<id>.jsonl`): a resumed session's file is its own session, and a
record copied into it from an earlier file counts only in that file; a file holding nothing but copies is no session.
Codex sessions sum each request's `last_token_usage`, never `total_token_usage`. Claude Code writes one line per content
block of a response, each with the response's usage: a request (`message.id`, `requestId`) counts once, at its last
line's usage. OpenCode's `output` leaves the reasoning out, so `output` is `output + reasoning`; an older OpenCode's
already held it, and where a step records `total`, `output` is what the total leaves after the input and the cache. Each
step of an OpenCode message is one request, at its `step-finish` part's usage (the message keeps only the last step's).

## Readers

A source is a `Reader` in the registry (`READERS`), with the harness that runs what it ran and the name a person reads:

```ts
type Locator = { file: string; id?: string };
type Reader<S extends string, C> = {
  source: S;
  name: string;
  harness: string;
  discover(home: string, env?: Env): Promise<Locator[]>;
  read(locator: Locator, cursor?: C, options?: { turns?: boolean; seen?: Set<string> }): Promise<{ sessions: SessionRead<S>[]; cursor: C; read: number; resumed: boolean }>;
  order?(a, b): number;
  children?(home: string, env?: Env): Promise<{ locator: Locator; of: Locator }[]>;
  stat?(locator: Locator): Promise<{ bytes: number; mtimeMs: number; parent?: string } | null>;
  parentOf?(locator: Locator): Promise<string | undefined>;
};
```

The cursor is the reader's own: hand it back to the same reader for the same locator. A JSONL source builds its reader
with `lineReader` from a per-record function; its cursor is the file's device and inode, the byte after the last whole
line read, and the read's state. A file replaced or truncated since is read from its start, and a last line with no
newline yet is read but not consumed. A source that keeps many sessions in one file (a SQLite database) implements
`discover` and `read` itself and returns one locator per session, with its `id`, and `stat`: the session's own size and
last write, which a caller's size caps and "still being written" check go by (`locatorSize`; without `stat`, the file's).

OpenCode is that source. Its sessions are in `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode`): `opencode*.db` (1.x
and 2.x schemas; a 2.x session wins over the 1.x copy beside it), the database `OPENCODE_DB` names, and the JSON
`storage/` OpenCode kept before SQLite. A locator is `{ file: <db>, id: <session id> }`, or a storage session's own
JSON file; each session is listed once, the first database's that holds it. Its cursor is the file's device and inode
and a stamp of the session's rows (each table's row count and latest `time_updated`): an unchanged session is not read
again, a changed one is read again whole, a replaced database from its start. A fork's rows copied from its source
session count nothing. A database session's `stat` is the bytes of its messages' and parts' `data` and the latest
`time_updated` of its rows; a storage session's, its files' together. It reads SQLite with `node:sqlite` under Node and `bun:sqlite` under Bun.

`readSession(locator, source)`, `sessionLocators(home, source)`, `inOrder(locators, source)` (each locator with its
`locatorSize`; one whose size query throws is kept, marked `failed`, for the caller to read or report), `locatorSize(locator, source)` (null when the session is gone, any other error thrown), `locatorParent(locator, source)` and `childrenOf(home, source)` are what
serve's import reads through. `locatorParent` names the session a subagent ran under without reading the subagent: the
`parent` its reader's `stat` gives (an OpenCode row's), else its reader's `parentOf`. Codex's reads a rollout's first
line, `session_meta`, and never more than 256 KiB of it. serve uses it to tie a subagent over the cap to its run, which
it then holds back. The
mirror rule is one export for both callers: `mirroredIn(counted)` over the `sessionKey(source, id)` of the sessions
counted, and `ownRequests(requests, cost, mirrored)` for a session's own requests and cost.
