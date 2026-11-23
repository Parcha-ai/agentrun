# @parcha/agentrun-import

Reads the coding-agent sessions under a home (Claude Code, Codex, pi, Factory Droid) into one Session shape: normalized
token usage, subagents counted under their parent, and byte-offset cursors so a second pass reads only what was
appended. AgentRun's server imports past sessions through it.

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
node dist/cli.js <home> [--sources claude-code,codex,pi,droid] --known-answer
```

One JSONL line per session, sorted by key: `{key, source, tokens: {input, output, cacheRead, cacheWrite, cacheWrite1h},
cost, turns, calls}`. Numbers only: no content, title, directory or path is printed. `--help` (`-h`) prints the usage
and exits 0; a bad argument exits 2. A file that cannot be read prints no answer: one stderr line per such file
(`agentrun-import: cannot read <source> <key> (<code>)`) and exit 1. The CLI imports pi-ai statically for its prices:
a bundle (`bun build --compile`) carries it, prints the same bytes as under Node, and a build or run without pi-ai
fails instead of pricing nothing. pi-ai is a dependency of the package, so `npx @parcha/agentrun-import` runs the
CLI as it is; the library loads it only to price.

## Usage

`normalizeUsage(format, raw)` reads one request's usage as `"anthropic"`, `"openai"`, `"pi"` or `"droid"` writes it:

| Source | `input` | `cacheWrite1h` | `reasoning` |
| --- | --- | --- | --- |
| Anthropic | `input_tokens` (already excludes the cache) | `cache_creation.ephemeral_1h_input_tokens` | |
| OpenAI, Codex | `input_tokens - cached_input_tokens` | | `reasoning_output_tokens` (part of `output`) |
| pi | `input` | `cacheWrite1h` | |
| Droid | `inputTokens` (already excludes the cache) | | `thinkingTokens` (part of `output`) |

A Claude Code session's id is its file's name (`<id>.jsonl`): a resumed session's file is its own session, and a
record copied into it from an earlier file counts only in that file; a file holding nothing but copies is no session.
Codex sessions sum each request's `last_token_usage`, never `total_token_usage`. Claude Code writes one line per content
block of a response, each with the response's usage: a request (`message.id`, `requestId`) counts once, at its last
line's usage.

### Factory Droid

Sessions are `~/.factory/sessions/<cwd slug>/<session id>.jsonl` (some in `sessions/` itself), under
`$FACTORY_HOME_OVERRIDE` instead of the home where `env` names it. Each assistant message is one request, each record
counted once by its `id` (a fork copies its source's records). A Worker, whose `session_start` names its
`callingSessionId`, counts under that session.

Droid writes no request's tokens. The `<session id>.settings.json` beside the transcript holds the session's running
total (`tokenUsage`, its own calls alone; `inclusiveTokenUsage` is not read, as the Workers count on their own) and its
latest `model`, read whole on each read. That total goes on the session's last request, the others 0, or on a request
of its own when the transcript holds none. So:

- A session with no settings file, or one with no `tokenUsage`, is unmetered: its requests have no usage, and cost
  `null`.
- Droid writes no dollar cost. `cost` is the total at the catalog's list price for the model `settings.json` names (the
  session's latest; a session that switched models is priced at that one), else the model of the last request; `null`
  with neither, or for a model the catalog does not list (a BYOK `custom:` model).
- A turn ends with an `agent_turn_outcome` record. One whose provider refused or never answered (`model_rate_limited`,
  `model_provider_unreachable` and the like) is one more request, failed: its error is the reason with turns, a fixed
  `"API error"` without them. Droid's own failures fail the session with no request; a cancel stops it.
- `droidSessionId(file, sessionStart?)` is the one rule for a session's id (its `session_start`'s, else the file's
  name), which serve's import reads too.

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
