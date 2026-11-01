# @parcha/agentrun-codex

Codex as an AgentRun harness: a DSL `agent` node runs on Codex through `@parcha/agentrun-adapters`, durable in AgentRun's
own store, with the host's tools as its only tools. It is held: not on npm yet.

```ts
import { createHarnessRunner } from "@parcha/agentrun-adapters";
import { codexAdapter } from "@parcha/agentrun-codex";

const runNode = createHarnessRunner(
  codexAdapter({
    model: "gpt-5.4-mini",
    provider: { origin: "https://api.openai.com", credential: () => process.env.OPENAI_API_KEY! },
    sessionsDir: "/var/lib/my-host/codex-sessions",
  }),
  { store, tools },
);
```

- **The host's tools only.** Codex's app-server runs with its built-in tools off: no shell, no file edits, no web, no
  images, no sub-agents. A classic model is offered exactly the host's tools (and the runner's `submit`); a code-mode
  model is offered code mode's `exec` and `wait`, whose runtime has no Node modules, no process and no network, and
  reaches the host's tools by their own names, as nested calls of the script it writes. The proxy passes `exec` and
  `wait` and drops the sub-agent and user-input tools Codex lists beside them; it keeps parallel tool calls off for a
  code-mode request, and offers no `exec` while a script that yielded still runs, so one script is live at a time. A
  nested call has an id of Codex's own (`exec-<uuid>`) that no line of the rollout carries and that names no `exec`, so
  the session ties it to the one live script: the `exec` the proxy's latest answer carried (read before Codex has that
  part of the answer) or that the rollout shows unfinished. A `never` tool's call waits for that `exec`'s line to be in
  the log, and is declined, never run, while two scripts are live. `test/tool-off.test.mjs` runs the pinned binary
  against a scripted model that calls every built-in, and checks that nothing runs, writes or spawns;
  `test/code-mode-never.test.mjs` runs a `never` tool from code mode, from a script that yielded, and from a second
  script a model wrote while the first ran. After a crash the harness's note about the interrupted turn reaches the model
  once, as a developer message injected on the recovery resume (Codex ignores new developer instructions on resume, and every
  turn opens with `thread/resume`), and the resumed turn's user input is the user's own words or `Continue.`.
- **The model behind a proxy.** Codex talks to a model proxy on the loopback interface with a key of its session's own;
  it never holds the provider key. The proxy forwards `POST /v1/responses` only, fixes the model, stores nothing at the
  provider, drops any tool that is not the session's, and asks the runner before every paid request, so the turn cap and
  the host's budget hold. Each response's usage comes back to the runner.
- **Web search, when asked.** The one exception to the above: `webSearch: "live"` sets `web_search = "live"` in Codex's
  config; the proxy then passes exactly the hosted tool Codex sends for it (`{ type: "web_search", external_web_access:
  true }`, recorded in `test/fixtures/responses-request-web-search-live.json`) and refuses any other web search tool.
  Each search a response ran (`tool_usage.web_search.num_requests`) is added to its price at OpenAI's $0.01 a call; a
  model with no known search price books an unknown cost. A request that offers web search has no input bound, so a cap
  treats its input as unknown.
- **A private, empty machine.** A session runs in its own directories with an empty working directory. Codex's
  environment is an allowlist (`PATH`, `LANG`, `TZ`, its own homes and the proxy key); nothing else of the host's
  reaches it, and its process group ends with the session.
- **The host's skills, and no others.** `codexAdapter({ skills: [{ name, files }] })`: Codex lists each skill to the model
  by its name and description, and the model reads its `SKILL.md` and the files it names with `read_skill_file` (it has
  no shell). The skills are written into the session's `CODEX_HOME` at the start of every drive, where Codex lists a
  user's skills even in a turn with its built-ins off (it lists none from a working directory's `.agents/skills` there).
  Codex's bundled skills (imagegen, openai-docs, skill-creator, skill-installer, ...) are off in every session, with
  skills or without. The skills are checked when the adapter is made, by `skillProblems` of `@parcha/agentrun-adapters`,
  the Claude adapter's check: a lowercase name, a `SKILL.md` whose front matter names it and describes it, plain
  relative paths, 1 MiB in all. Codex itself skips a skill with no front matter or no description and lists one under
  its front matter's name, so each of those is refused here instead.
- **Durable.** A session's records are in the store the host lends (Codex's rollout mirrored line by line, every tool
  call an effect recorded before it runs). A session a process died inside resumes from its records: a `safe` tool runs
  again, a `never` tool's cut-off call is reported to the model as interrupted and never repeated.

**Tool schemas.** Codex sanitizes the schema its model is given (measured on the pinned binary, recorded in `test/fixtures/schema-column.json`). The adapter refuses, when a session is checked, the shapes Codex drops or retypes (a tuple `items`, `prefixItems`, `patternProperties`, `if`/`then`/`else`, `not`, a non-scalar or untyped non-string `enum`/`const`, `contains`, `dependentRequired`, `propertyNames`, a boolean `items`, constraints inside `allOf`), naming the tool, the JSON pointer and the keyword. The keywords Codex only strips (bounds, patterns, formats, titles, defaults, examples) are listed in the tool's description, so the model still reads them; the host checks every call against the original schema. A schema object reused in two places is described at its first path.

The adapter is pinned to Codex 0.164.0. `@openai/codex` is the host's: an exact optional peer dependency, never shipped
here (`npm install --save-exact @openai/codex@0.164.0`). `codexAdapter()` checks the binary against the pins when it is
made and throws `CodexNotInstalled` or `CodexPinMismatch` before any run starts. `CODEX_BIN` names another path to the
same build.

Code this package copies from another project is listed in `vendor/durable-harness/UPSTREAM.json` and credited in
`NOTICE`.
