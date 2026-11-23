# @parcha/agentrun-import

Reads the coding-agent sessions under a home (Claude Code, Codex, pi) into one Session shape: normalized token usage,
subagents counted under their parent, and byte-offset cursors so a second pass reads only what was appended. AgentRun's
server imports past sessions through it.

## Totals for a home

```js
import { parseHome } from "@parcha/agentrun-import";

const sessions = await parseHome(homedir(), { sources: ["claude-code", "codex"] });
// [{ key, file, source, id, tokens: { input, output, cacheRead, cacheWrite, cacheWrite1h }, reasoning, cost, turns, calls, subagents }]
```

- `key` is the sha256 (hex) of the session's file path relative to the home, `"/"` between its parts, with `#<id>` after
  it for a file that holds many sessions. Lines come sorted by key.
- `tokens.input` is the input neither read from nor written to the cache, for every source (see `normalizeUsage`).
- `cost` is USD: the source's own when it wrote one (Claude Code's `cost-state`, pi's per-request cost), else the
  requests at pi-ai's list prices (a dependency, loaded on the first price), else `null`.
- `turns` counts the person's messages; `calls` the model requests, its subagents' with them, each once.
- `state: {}` handed to each call keeps cursors between calls: the second call reads only the bytes appended since, and
  returns what a fresh call would. When a file holding a copied record now comes before the file it counts in (an append
  moved the original after its resumed copy, or a new file sorts before one it shares records with), that source is read
  again from the start. The state holds counts, record ids and paths, never a prompt, title, working directory or
  answer; a file that fails to read gives up what it held and is read from its start next time.
- `failures: []` collects each file its reader could not read (`{ key, file, source, error }`) while the rest are
  totalled; without it, parseHome throws `ReadFailures`. An unreadable file is never taken for an empty one.
- `env` names where a source keeps its own directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); without it the home's.

## Known answer

```sh
node dist/cli.js <home> [--sources claude-code,codex,pi] --known-answer
```

One JSONL line per session, sorted by key: `{key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h},
cost, turns, calls}`. Numbers only: no content, title, directory or path is printed. `--help` (`-h`) prints the usage
and exits 0; a bad argument exits 2. A file that cannot be read prints no answer: one stderr line per such file
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
| `unknown` | none of the above |

`chain: true` keeps the session's `chain` beside its turns: each record's id and its parent's (Claude Code's
`uuid`/`parentUuid`, pi's `id`/`parentId`), a 16-hex sha256 of its content, never the content, and which record opens
each request. The analyzer finds an edit by comparing the hashes of the two prompts' message chains from the root. A
sidechain's prompt is a conversation of its own, never an edit of the main one's. A Codex rollout names no record to
rewind to, so a Codex break is never `edited`; pi writes no compaction or sidechain record in the sessions seen, so a pi
break is never `compaction` or `sidechain`. A session read without its chain names `model` and `idle` alone.

`cacheHome(home, options)` analyzes every session `parseHome` totals (the same options but `state`), keyed the same way,
one file at a time: `hitRate` over the session's requests and its subagents', and its breaks. A session's files (a Codex
thread that goes on in a new rollout) are one conversation in the import's order: a file's first turn is compared with
the last turn of the file before it (its model, time and cache life carried over), and turns count on across them. Two
sessions are never compared. Each subagent is a conversation of its own, its breaks with its `subagent` number.
`analyzeCache` hands back the `last` turn it compared, for the next file's `before`. `cacheTotals(sessions)` counts the breaks and sums their priced extra cost by
cause.

```sh
node dist/cli.js <home> [--sources claude-code,codex,pi] --cache
```

A JSONL line per session, sorted by key as `--known-answer`'s: `{key, source, hitRate, breaks: [{turn, at, dropPct,
rewritten, extraCost, cause}]}`, then one line `{totals: {sessions, breaks, extraCost, unpriced}}`. Numbers and cause
names only.

## Usage

`normalizeUsage(format, raw)` reads one request's usage as `"anthropic"`, `"openai"` or `"pi"` writes it:

| Source | `input` | `cacheWrite1h` | `reasoning` |
| --- | --- | --- | --- |
| Anthropic | `input_tokens` (already excludes the cache) | `cache_creation.ephemeral_1h_input_tokens` | |
| OpenAI, Codex | `input_tokens - cached_input_tokens` | | `reasoning_output_tokens` (part of `output`) |
| pi | `input` | `cacheWrite1h` | |

A Claude Code session's id is its file's name (`<id>.jsonl`): a resumed session's file is its own session, and a
record copied into it from an earlier file counts only in that file; a file holding nothing but copies is no session.
Codex sessions sum each request's `last_token_usage`, never `total_token_usage`. Claude Code writes one line per content
block of a response, each with the response's usage: a request (`message.id`, `requestId`) counts once, at its last
line's usage.

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
};
```

The cursor is the reader's own: hand it back to the same reader for the same locator. A JSONL source builds its reader
with `lineReader` from a per-record function; its cursor is the file's device and inode, the byte after the last whole
line read, and the read's state. A file replaced or truncated since is read from its start, and a last line with no
newline yet is read but not consumed. A source that keeps many sessions in one file (a SQLite database) implements
`discover` and `read` itself and returns one locator per session, with its `id`.

`readSession(locator, source)`, `sessionLocators(home, source)`, `inOrder(locators, source)` and
`childrenOf(home, source)` are what serve's import reads through.
