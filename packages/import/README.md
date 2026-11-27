# @parcha/agentrun-import

Reads the coding-agent sessions under a home (Claude Code, Codex, pi, OpenCode, GitHub Copilot CLI) into one Session shape: normalized token
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
  an OpenCode subagent's added to its parent's), else the requests at pi-ai's list prices (a dependency, loaded on the
  first price; a load that fails throws with its reason), else `null`.
- `turns` counts the person's messages; `calls` the model requests, its subagents' with them, each once.
- `state: {}` handed to each call keeps cursors between calls: the second call reads only the bytes appended since, and
  returns what a fresh call would. When a file holding a copied record now comes before the file it counts in (an append
  moved the original after its resumed copy, or a new file sorts before one it shares records with), that source is read
  again from the start. The state holds counts, record ids and paths, never a prompt, title, working directory or
  answer; a file that fails to read gives up what it held and is read from its start next time.
- `failures: []` collects each file its reader could not read (`{ key, file, source, error }`; an OpenCode database
  that does not open, for each session it lists or as itself when it lists none) while the rest are totalled; without
  it, parseHome throws `ReadFailures`. An unreadable file is never taken for an empty one.
- `env` names where a source keeps its own directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, OpenCode's `XDG_DATA_HOME` and
  `OPENCODE_DB`); without it the home's.
- `threads` reads the files on that many worker threads (default: the cores the process may run on less one, two on
  two, at most 16, and no more than the workers whose heaps, 80 MiB each at the default `workerOldMb`, fit in the memory
  still free (the machine's, page cache counted as free, at most its container's limit) once `readAhead` is set aside;
  `1` reads them in order on the calling thread; at most 64). A read is kept only when it is the one the import's order
  would make; any other file is read again in order, so the totals are the same whatever the count. A call with a
  `state`, or with readers of its own, reads on the calling thread; so does OpenCode in any call (its sessions are rows of
  a database, not files of lines).
- `readAhead` caps the bytes of finished reads waiting to be taken (default 1 GiB, or a sixteenth of the memory the
  process may use, its container's limit when one is set, when that is less: 512 MiB at 8 GiB). Under it, files of 64 MiB and over are read first, largest first, then
  the rest in order; at it, the threads read only the file the import waits on. It is a cap on finished reads waiting,
  plus at most one read in flight per thread (one of those can be a giant file), not on the process's memory.
- `workerOldMb` caps each worker's old generation (default 64, at least 8, refused with a RangeError under it: at 1 or
  2 MB V8 ends the whole process as a worker starts, and at 3 to 7 the workers run out of memory). A line over an eighth of it, or a file that runs a worker
  out of memory, is read on the calling thread instead; past two such losses a thread, the calling thread reads the rest.
  Each reading thread (each worker, and the calling thread) also holds up to 8 MiB of scanner memory outside its heap:
  the scanner's stack and tables, and room for the longest line it read. A line that would take it past 8 MiB (one over
  about 6.7 MiB) is parsed whole instead, with the same totals.
- A request two sources wrote is counted once. OpenCode's claude-agent provider runs Claude Code, which writes each
  request into its own session file too; OpenCode names that session on the request (`mirrors`). When the same call
  reads that Claude Code session (serve's import: or its store holds it), the request counts there and not in the OpenCode session (tokens, calls and cost),
  request by request: one OpenCode session can mix claude-agent requests with other providers'. When it does not, the
  request counts in OpenCode's.

## A year of work

```js
import { wrappedHome } from "@parcha/agentrun-import";

const year = await wrappedHome(homedir(), 2026); // the same options as parseHome, but `state`
```

`wrappedHome(home, year)` buckets by each request's time, in the machine's local zone, so a session that spans New Year
splits: `tokens`, `requests`, `days` (`{day, requests, tokens}`), `hours` (24) and `weekdays` (7, Sunday first),
`activeMs` (the gaps between a session's requests of the year, each counted when under 15 minutes), `models`,
`harnesses` and `sources`. A session counts in `sessions` (and its prompts in `turns`) for the year its first request is in.
`cost` is the catalog's list price of the requests it could price; `unpricedRequests` counts the rest. Like the totals, it
holds counts, names and times only: no prompt, title, path or project. `parseHome`'s `requests` option is the hook it is
built on: each session's totals and its requests, as they are totalled. With it, parseHome keeps every request (its model,
tokens and time) until its session is totalled; without it, each request is priced as its file is read and only its
cost is kept. Each call reads with a pool of its own, at the defaults unless `threads` or `readAhead` is passed: two
calls at once hold two pools' memory.

## Known answer

```sh
node dist/cli.js <home> [--sources claude-code,codex,pi,opencode,copilot] [--threads N] [--read-ahead BYTES[k|m|g]] --known-answer
```

One JSONL line per session, sorted by key: `{key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h},
cost, turns, calls}`. Numbers only: no content, title, directory or path is printed. `--help` (`-h`) prints the usage
and exits 0; a bad argument exits 2. `--threads` and `--read-ahead` set parseHome's `threads` and `readAhead` (`1`, or
`256m`, holds less memory); the answer is the same. A file that cannot be read prints no answer: one stderr line per such file
(`agentrun-import: cannot read <source> <key> (<code>)`) and exit 1. The CLI imports pi-ai statically for its prices:
a bundle (`bun build --compile`) carries it, prints the same bytes as under Node, and a build or run without pi-ai
fails instead of pricing nothing. pi-ai is a dependency of the package, so `npx @parcha/agentrun-import` runs the
CLI as it is; the library loads it only to price.

## Cache breaks

```js
import { analyzeCache, cacheHome, readSession } from "@parcha/agentrun-import";

const session = await readSession(file, "claude-code", { chain: true });
const { hitRate, breaks } = await analyzeCache(session);
// breaks: [{ turn, at, dropPct, rewritten, extraCost, cause, diverged? }]
```

- `hitRate` is the cache read over the whole prompt (`input + cacheRead + cacheWrite`, input already uncached), null for a
  session that sent none.
- A break is a turn whose cache read dropped more than 80% (`BREAK_DROP`) against the turn before it; the first turn is
  never one, and a drop of exactly 80% is none. A turn compared is a request with usage that sent a prompt. `turn`
  counts the session's requests from 1; `at` is ms since the epoch; `dropPct` the share of the turn before's read lost.
- `rewritten`: of the read lost, the tokens the turn paid for again, as a cache write or as uncached input. `extraCost`:
  USD, what the turn paid above reading them from the cache, at its model's list prices (pi-ai's catalog, or the
  `catalog` handed in); null when the model is not listed or `catalog: false`.
- `cause`, the first of `CACHE_CAUSES` the transcript shows evidence of:

| Cause | Evidence |
| --- | --- |
| `model` | the turn ran on another model than the turn before |
| `idle` | the gap since the turn before is past the cache's life: 5 minutes, or an hour when the latest cache write was a 1h one (`cacheWrite1h`) |
| `compaction` | a compaction since the turn before: Claude Code's `compact_boundary` or `isCompactSummary` record, Codex's `compacted`. It counts in the file that holds it first; across a session's files it carries to the next file's first turn, and a later file's copy of it is never consulted |
| `edited` | the prompt leaves the chain of the turn before (its prompt and answer) at an earlier message: `diverged` is that message's index |
| `sidechain` | the turn opens a sidechain after a main-chain turn (Claude Code's `isSidechain`) |
| `unknown` | none of the above: the transcript shows no cause for the drop. That names no cause, the provider's included. A cache evicted early, or a request served where its cache was not, reads this way, and so does an edit the analyzer cannot see: across two of a session's files (their chains are not compared), in a Codex rollout, or in a session read without its chain |

`chain: true` keeps the session's `chain` beside its turns: each record's id and its parent's (Claude Code's
`uuid`/`parentUuid`, pi's `id`/`parentId`), a 16-hex sha256 of its content, never the content, and which record opens
each request. The analyzer finds an edit by comparing the hashes of the two prompts' message chains from the root. A
sidechain's prompt is a conversation of its own, never an edit of the main one's. A Codex rollout names no record to
rewind to, so a Codex break is never `edited`; pi writes no compaction or sidechain record in the sessions seen, so a pi
break is never `compaction` or `sidechain`. A session read without its chain names `model` and `idle` alone.

`cacheHome(home, options)` analyzes every session `parseHome` totals (the same options but `state`), keyed the same way,
of the sources that write a chain (`CACHE_SOURCES`: Claude Code, Codex and pi; another source is refused with a
`RangeError`, since OpenCode's claude-agent requests mirror a Claude Code session's and would count twice),
one file at a time: `hitRate` over the session's requests and its subagents', and its breaks. A session's files (a Codex
thread that goes on in a new rollout) are one conversation in the import's order: a file's first turn is compared with
the last turn of the file before it (its model, time and cache life carried over), and turns count on across them. Two
sessions are never compared. Each subagent is a conversation of its own, its breaks with its `subagent` number: a
subagent's thread that goes on in a new rollout is one, its files joined the same way.
`analyzeCache` hands back the `last` turn it compared, for the next file's `before`. `cacheTotals(sessions)` counts the breaks and sums their priced extra cost by
cause.

```sh
node dist/cli.js <home> [--sources claude-code,codex,pi] --cache
```

A JSONL line per session, sorted by key as `--known-answer`'s: `{key, source, hitRate, breaks: [{turn, at, dropPct,
rewritten, extraCost, cause}]}`, then one line `{totals: {sessions, breaks, extraCost, unpriced}}`. Numbers and cause
names only.

## Usage

`normalizeUsage(format, raw, options?)` reads one request's usage as `"anthropic"`, `"openai"`, `"pi"`, `"opencode"` or `"copilot"` writes it:

| Source | `input` | `cacheWrite1h` | `reasoning` |
| --- | --- | --- | --- |
| Anthropic | `input_tokens` (already excludes the cache) | `cache_creation.ephemeral_1h_input_tokens` | |
| OpenAI, Codex | `input_tokens - cached_input_tokens` | | `reasoning_output_tokens` (part of `output`) |
| pi | `input` | `cacheWrite1h` | |
| OpenCode | `input` (already excludes the cache; `cache.read`, `cache.write`) | | `reasoning`, added to `output` |
| Copilot CLI | `inputTokens - cacheReadTokens - cacheWriteTokens` | | `reasoningTokens` (part of `output`) |

A Claude Code session's id is its file's name (`<id>.jsonl`): a resumed session's file is its own session, and a
record copied into it from an earlier file counts only in that file; a file holding nothing but copies is no session.
Codex sessions sum each request's `last_token_usage`, never `total_token_usage`. Claude Code writes one line per content
block of a response, each with the response's usage: a request (`message.id`, `requestId`) counts once, at its last
line's usage. OpenCode's `output` leaves the reasoning out, so `output` is `output + reasoning`. An OpenCode before
1.3.16 (`options.version`, the session's `version`) wrote it in `output` already, so its `output` stays as written; where
a step records `total`, `output` is what the total leaves after the input and the cache, whatever the version. Each
step of an OpenCode message is one request, at its `step-finish` part's usage (the message keeps only the last step's).

### GitHub Copilot CLI

Sessions are `$COPILOT_HOME/session-state/<id>/events.jsonl` (`~/.copilot` without `COPILOT_HOME`), and an older CLI's
`session-state/<id>.jsonl`. Each model call is one request, keyed by its first `assistant.message`'s `messageId`; a
response split into chunks (each chunk a message with its own `messageId`, the call's `apiCallId` the same) is one. Each
event counts once by its `id` and each message once by its `messageId`, across files too: a copied session adds no
request, and its copied shutdown no tokens. A rotated journal's `checkpoint: true` records are copies. A user message
is the person's unless a subagent, autopilot, a skill or another agent wrote it. A session's id is its `session.start`
`sessionId`, else `copilotSessionId(file)`: the folder's name, or the older flat file's.

Copilot writes no request's tokens to disk: `assistant.usage` is ephemeral. Its tokens are the `modelMetrics` of the
`session.shutdown` each CLI process writes as it exits, per model, subagents included. A CLI that keeps its accounting
across processes (`session.usage_checkpoint`, a shutdown with `usageAccountingWatermarks`) writes the session's whole
total there, so a shutdown counts only what it adds to the ones before it; an older CLI's counts its own process. A
model's tokens go on the last request of that model since the process started or resumed the session, or on a request
of their own when there is none (a compaction's model). That model's other requests in the process are `folded` into
it: zeros, known, never unknown. So:

- A session with no shutdown (still running, killed, or left with `/new`) has tokens 0 and cost `null`.
- Copilot bills premium requests and AI credits and writes no dollar cost. `cost` is the catalog's list price of the
  requests that carry the tokens, and `null` when a request's tokens are unknown or its model is not in the catalog.
- `events.N.jsonl` archives (written only with `COPILOT_SESSION_EVENT_LOG_ROTATION_BYTES`) and the pre-0.0.342
  `history-session-state` folder are not read. A rotated session's tokens still come whole from its last shutdown;
  the requests in its archives are not counted.

## Readers

A source is a `Reader` in the registry (`READERS`), with the harness that runs what it ran and the name a person reads:

```ts
type Locator = { file: string; id?: string };
type Reader<S extends string, C> = {
  source: S;
  name: string;
  harness: string;
  discover(home: string, env?: Env): Promise<Locator[]>;
  idOf(locator: Locator): string;
  read(locator: Locator, cursor?: C, options?: { turns?: boolean; totals?: boolean; seen?: Set<string>; lookups?: Map<string, unknown> }): Promise<{ sessions: SessionRead<S>[]; cursor: C; read: number; resumed: boolean }>;
  order?(a, b): number;
  children?(home: string, env?: Env): Promise<{ locator: Locator; of: Locator }[]>;
  stat?(locator: Locator): Promise<{ bytes: number; mtimeMs: number; parent?: string } | null>;
  parentOf?(locator: Locator): Promise<string | undefined>;
};
```

`idOf` is the id a read gives the locator's session when no record names one (Claude Code's always: its file's name;
pi's the last `_` part of its file's name; an OpenCode locator's `id`): a caller that names a session without reading it
takes the same id.

`lookups` is one map per import, shared by all its reads: a reader keeps there what it looks up once for the whole
import (the Codex reader, the rollouts under a sessions directory, listed the first time a fork's parent is not on its
own date). `parseHome` passes one; with threads, each worker of its read pool keeps one for the import. Without it, each
read looks up afresh.

The cursor is the reader's own: hand it back to the same reader for the same locator. A JSONL source builds its reader
with `lineReader` from a per-record function; its cursor is the file's device and inode, the byte after the last whole
line read, and the read's state. A file replaced or truncated since is read from its start, as is a cursor whose state
is of another shape than the reader's (its `stateVersion`: a Codex cursor saved by 0.1.0-beta.59 or before), and a last
line with no newline yet is read but not consumed. A source that keeps many sessions in one file (a SQLite database) implements
`discover`, `idOf` and `read` itself and returns one locator per session, with its `id`, and `stat`: the session's own size and
last write, which a caller's size caps and "still being written" check go by (`locatorSize`; without `stat`, the file's).

OpenCode is that source. Its sessions are in `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode`): `opencode*.db` (1.x
and 2.x schemas; a 2.x session wins over the 1.x copy beside it), the database `OPENCODE_DB` names, and the JSON
`storage/` OpenCode kept before SQLite. A locator is `{ file: <db>, id: <session id> }`, or a storage session's own
JSON file; each session is listed once, from the database that wrote it last (its rows' latest `time_updated`; a tie,
the first database). Its cursor is the file's device and inode
and a stamp of the session's rows (each table's row count and latest `time_updated`): an unchanged session is not read
again, a changed one is read again whole, a replaced database from its start. A fork's rows copied from its source
session count nothing. A 2.x fork marks them. A 1.x fork (OpenCode's `fork()` copies each message under a new id, its
time, tokens and cost as they were) and a 2.x row with no mark are told by a fingerprint: a request's time, step, model,
tokens and cost as written, a prompt's time and text. `order` reads a home's sessions oldest first, so a source comes
before its forks, and the cursor keeps the fingerprints its read took, so a session read again is no copy of itself.
A row time past now reads as its database's last write (its file's or its `-wal`'s, never past now): the same at each look, so the session ages out as its file does. A `turns: false` read keeps a request's error as `failed`, never its text. A database session's `stat` is the bytes of its messages' and parts' `data` and the latest
`time_updated` of its rows; a storage session's, its files' together. It reads SQLite with `node:sqlite` under Node and `bun:sqlite` under Bun, read-only, waiting up to 5 s on a write lock.

With `turns: false`, `totals: true` asks for only what `parseHome` totals: each session read then has `counts` set and
`requests` empty. Only a `lineReader` whose source sets `totals: true` (one that sets no turn's model, usage or time after
adding it) reads so; Claude Code's, Codex's and pi's do. Any other reader ignores the option, and its sessions have
`requests` whole and no `counts`. `Counts` holds the requests in typed arrays, in order:

- `n`: the number of requests.
- `models`: each model name once; `model[i]` is request `i`'s index into it, or -1 for none named.
- `values`: seven numbers a request, from `i * 7`: input, output, cacheRead, cacheWrite, cacheWrite1h and reasoning
  tokens, then the request's time (the `at` a read of turns gives it, in ms since the epoch).
- `has[i]`: which usage request `i` has, as bits: 1 its usage at all, 2 cacheWrite1h, 4 reasoning.

`atOf(counts, i)` reads request `i`'s time:

```ts
import { atOf, READERS } from "@parcha/agentrun-import";

const reader = READERS["claude-code"];
for (const locator of await reader.discover(home)) {
  const { sessions } = await reader.read(locator, undefined, { turns: false, totals: true });
  for (const read of sessions) {
    if (!read.counts) continue; // a reader with no totals read: read.requests holds its requests whole
    for (let i = 0; i < read.counts.n; i++) console.log(read.session.id, new Date(atOf(read.counts, i)).toISOString());
  }
}
```

`readSession(locator, source)`, `sessionLocators(home, source)`, `inOrder(locators, source)` (each locator with its
`locatorSize`; one whose size query throws is kept, marked `failed`, for the caller to read or report), `locatorSize(locator, source)` (null when the session is gone, any other error thrown), `locatorParent(locator, source)` and `childrenOf(home, source)` are what
serve's import reads through. `locatorParent` names the session a subagent ran under without reading the subagent: the
`parent` its reader's `stat` gives (an OpenCode row's), else its reader's `parentOf`. Codex's reads a rollout's first
line, `session_meta`, 256 KiB at a time and never past 64 MiB: a first line longer than that names no parent. serve uses it to tie a subagent over the cap to its run, which
it then holds back. The
mirror rule is one export for both callers: `mirroredIn(counted)` over the `sessionKey(source, id)` of the sessions
counted, and `ownRequests(requests, cost, mirrored)` for a session's own requests and cost.
