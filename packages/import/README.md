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
  requests at pi-ai's list prices (an optional peer), else `null`.
- `turns` counts the person's messages; `calls` the model requests, its subagents' with them, each once.
- `state: {}` handed to each call keeps cursors between calls: the second call reads only the bytes appended since.
- `env` names where a source keeps its own directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); without it the home's.

## Known answer

```sh
node dist/cli.js <home> [--sources claude-code,codex,pi] --known-answer
```

One JSONL line per session, sorted by key: `{key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h},
cost, turns, calls}`. Numbers only: no content, title, directory or path is printed. `src/cli.ts` compiles with
`bun build --compile` and prints the same bytes as under Node.

## Usage

`normalizeUsage(format, raw)` reads one request's usage as `"anthropic"`, `"openai"` or `"pi"` writes it:

| Source | `input` | `cacheWrite1h` | `reasoning` |
| --- | --- | --- | --- |
| Anthropic | `input_tokens` (already excludes the cache) | `cache_creation.ephemeral_1h_input_tokens` | |
| OpenAI, Codex | `input_tokens - cached_input_tokens` | | `reasoning_output_tokens` (part of `output`) |
| pi | `input` | `cacheWrite1h` | |

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
