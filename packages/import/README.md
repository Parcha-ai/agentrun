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
- `threads` reads the files on that many worker threads (default: the cores the process may run on, at most 8; `1`
  reads them in order on the calling thread). A read is kept only when it is the one the import's order would make; any
  other file is read again in order, so the totals are the same whatever the count. A call with a `state`, or with
  readers of its own, reads on the calling thread.
- `readAhead` caps the bytes of finished reads waiting to be taken (default 1 GiB, or a sixteenth of the machine's
  memory when that is less: 512 MiB at 8 GiB). Under it, files of 64 MiB and over are read first, largest first, then
  the rest in order; at it, the threads read only the file the import waits on. It is a cap on finished reads waiting,
  plus at most one read in flight per thread (one of those can be a giant file), not on the process's memory.
- `workerOldMb` caps each worker's old generation (default 64). A line over an eighth of it, or a file that runs a worker
  out of memory, is read on the calling thread instead; past two such losses a thread, the calling thread reads the rest.

  On a 73.7 GB home, 8 threads took 90.9 s (median of 5) at a peak of 1.83 GiB, and 1 thread 441.1 s at 1.05 GiB
  (x1); with `readAhead` at 256 MiB, 8 threads took 136.5 s (x1). Measured on a loaded machine (load 17 to 45).

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
node dist/cli.js <home> [--sources claude-code,codex,pi] [--threads N] [--read-ahead BYTES[k|m|g]] --known-answer
```

One JSONL line per session, sorted by key: `{key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h},
cost, turns, calls}`. Numbers only: no content, title, directory or path is printed. `--help` (`-h`) prints the usage
and exits 0; a bad argument exits 2. `--threads` and `--read-ahead` set parseHome's `threads` and `readAhead` (`1`, or
`256m`, holds less memory); the answer is the same. A file that cannot be read prints no answer: one stderr line per such file
(`agentrun-import: cannot read <source> <key> (<code>)`) and exit 1. The CLI imports pi-ai statically for its prices:
a bundle (`bun build --compile`) carries it, prints the same bytes as under Node, and a build or run without pi-ai
fails instead of pricing nothing. pi-ai is a dependency of the package, so `npx @parcha/agentrun-import` runs the
CLI as it is; the library loads it only to price.

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
  read(locator: Locator, cursor?: C, options?: { turns?: boolean; totals?: boolean; seen?: Set<string> }): Promise<{ sessions: SessionRead<S>[]; cursor: C; read: number; resumed: boolean }>;
  order?(a, b): number;
  children?(home: string, env?: Env): Promise<{ locator: Locator; of: Locator }[]>;
};
```

The cursor is the reader's own: hand it back to the same reader for the same locator. A JSONL source builds its reader
with `lineReader` from a per-record function; its cursor is the file's device and inode, the byte after the last whole
line read, and the read's state. A file replaced or truncated since is read from its start, and a last line with no
newline yet is read but not consumed. A source that keeps many sessions in one file (a SQLite database) implements
`discover` and `read` itself and returns one locator per session, with its `id`.

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

`readSession(locator, source)`, `sessionLocators(home, source)`, `inOrder(locators, source)` and
`childrenOf(home, source)` are what serve's import reads through.
