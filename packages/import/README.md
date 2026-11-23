# @parcha/agentrun-import

Reads the coding-agent sessions under a home (Claude Code, Codex, pi) into one Session shape: normalized token usage, and
subagents counted under their parent. AgentRun's server imports past sessions through it.

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
  requests at pi-ai's list prices (a dependency, loaded on the first price; a load that fails throws), else `null`.
- `turns` counts the person's messages; `calls` the model requests, its subagents' with them, each once.
- Each call reads every file whole. A record copied into many files (a resumed session's) counts in the first of them.
- `failures: []` collects each file its reader could not read (`{ key, file, source, error }`) while the rest are
  totalled, as if the failed file were not there; without it, parseHome throws `ReadFailures`. An unreadable file is never taken for an empty one.
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
type Reader<S extends string> = {
  source: S;
  name: string;
  harness: string;
  discover(home: string, env?: Env): Promise<Locator[]>;
  idOf(locator: Locator): string; // the id of a session no record names
  read(locator: Locator, options?: { turns?: boolean; seen?: Set<string> }): Promise<{ sessions: SessionRead<S>[] }>;
  order?(a, b): number;
  children?(home: string, env?: Env): Promise<{ locator: Locator; of: Locator }[]>;
};
```

A JSONL source builds its reader with `lineReader` from a per-record function; a last line with no newline yet is read
like any other. A source that keeps many sessions in one file (a SQLite database) implements
`discover` and `read` itself and returns one locator per session, with its `id`.

`readSession(locator, source)`, `sessionLocators(home, source)`, `inOrder(locators, source)` and
`childrenOf(home, source)` are what serve's import reads through.
