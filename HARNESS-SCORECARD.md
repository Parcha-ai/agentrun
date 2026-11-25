# Harness scorecard

Whether 25 ACP agents fit door 1 ([HARNESS.md](HARNESS.md#a-recipe)), and what's in the way.

As of main `98c17062ca`, 2026-11-19, from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
of that day and the vendors' public documentation; nothing here was run on a vendor's account except Goose, whose recipe
passed `harness-check` on a model through AgentRun's proxy, and Google Antigravity, whose recipe passed it on a Gemini
API key (2026-11-25). Re-rated on 2026-11-22 for what a recipe gained since: `.zip` releases, the whole-tree pin,
per-platform `args`, a key handed under the name the agent reads, `keyMethod` and the owner's own sign-in made by the
agent. Google Antigravity's row is Google's own agy CLI release of that day, and
its recipe is [examples/harness-recipe/antigravity.json](examples/harness-recipe/README.md); the other rows keep
2026-11-19's versions.

**The bar for a clean fit.** Every rule ([the five rules](HARNESS.md#the-five-rules)) holds with what's on
main, and the agent passes every stage of `agentrun harness-check` with nothing of AgentRun's run beside it but the
recipe's own files. A plan-billed agent's model requests never reach this host, so its check says two stages (its own
tools off, what it sends to `hosts`) are **unverified** and passes on the rest; its row says so.

**Fits if** means no workaround code is left, but a fact about the agent hasn't been checked on a real run. Those facts
are marked **unverified** everywhere on this page. Most of them are lines
[`agentrun harness-check`](HARNESS.md#check-it) prints from one run: whether the agent's own tools turn off,
whether it resumes with `session/load`, whether it asks before a tool call, and what it reaches for beyond loopback.

**Needs a workaround** names the code a recipe would need that the loader, the installer or the model proxy has no
shared piece for. **Blocked** names the rule a recipe can't keep for the agent today. A row's distribution and digests
are the registry's for `linux-x86_64`.

## The table

Of 25 rows: 2 clean, 10 fit if unverified facts hold, 1 needs a workaround, 12 are blocked. Two are built in: Goose (also a
recipe in this page's proof) and Cursor ([harness-cursor.ts](packages/serve/src/harness-cursor.ts)). The installer unpacks `.tar.bz2`, `.tar.gz` and `.zip`
([harness-archive.ts](packages/serve/src/harness-archive.ts) ARCHIVE_FORMATS), and a recipe's loader takes the same three
formats; the rows below are rated with it. A key the server holds under a provider's name (`GEMINI_API_KEY`,
`MISTRAL_API_KEY`, ...) no longer blocks a row: the owner saves the harness's own key under a name of its own and hands
it to the agent under the provider's (rule 1).

| Agent | Registry release | Fit | Billing a recipe would use | What's open |
| --- | --- | --- | --- | --- |
| Goose | `goose` 1.60.1 (main pins 1.59.2), binary `.tar.bz2` with sha256 | clean fit (built: a recipe for 1.59.2 passes `harness-check` on OpenRouter's Claude Haiku 4.5; resume `load`, tool_gate `permission`) | proxy, `GOOSE_MODEL` | the proxy's policy is Goose's own: a new Goose that sends a new `anthropic-beta` value is refused until the policy learns it. Goose titles a call of ours `agentrun: check echo` (the tool's underscores as spaces), which the ACP adapter ties to our tool, so the host's gate is asked once, at the MCP call; it asks for `models.dev:443` at every start, refused, and makes no other request beyond loopback |
| Cursor | `cursor` 2026.11.13, binary `.tar.gz`, no sha256 | built in; as a recipe, needs a workaround: a recipe names no credential file, and Cursor derives one from its key (`auth.json`) | plan, on the owner's own Cursor key | the registry lists no digest: serve pins the archive, the launcher and every file it unpacks to, and refuses any drift |
| Google Antigravity | Google's agy CLI 1.5.14 (`agy acp`), binary `.tar.gz` with the sha512 its manifest lists (the registry's `antigravity-acp` server lacks `--login` and `--gemini-dir`) | clean fit (checked: the recipe passes `harness-check` on a Gemini API key, linux-x86_64, 2026-11-25; resume `load`, tool_gate `permission`) | plan, on the owner's own sign-in by `agy acp --login --gemini-dir DIR`, as T3 Code runs it, or a Gemini API key from Google AI Studio saved as `ANTIGRAVITY_GEMINI_API_KEY`, handed as `GEMINI_API_KEY` with `keyMethod` `gemini-api-key` ([Sign-in](HARNESS.md#sign-in), [Vendor terms](HARNESS.md#vendor-terms)) | its initialize advertises `loadSession` and no MCP over HTTP, so our tools go over stdio; its conversations are SQLite files in `.gemini/antigravity-cli/conversations` (the recipe's `state`), which another runner's agent loads. It names a call of ours `mcp_agentrun_<tool>` (titled `Run mcp_agentrun_<tool>`) and adds a `toolSummary` of its own to the arguments it reports. Plan billing: tools off and what it sends to `hosts` are **unverified** |
| Kimi CLI (legacy) | `kimi` 1.52.0, binary `.tar.gz` with sha256 | fits if its facts hold | plan, on a key saved for it alone and handed as `KIMI_API_KEY` or `MOONSHOT_API_KEY` (rule 1); **unverified**: which of the two it reads | tools off, resume and permission asks, **unverified** |
| Devin | `devin` 3000.14.30821, binary `.tar.gz`, no sha256 | fits if a key can carry its account | plan, on the owner's Devin account; **unverified**: a key a recipe can name | no digest in the registry: the writer pins the archive, the first binary digest is recorded |
| Junie | `junie` 4100.8.0, binary `.zip`, no sha256 | fits if a key can carry its account | plan, on the owner's JetBrains account; **unverified**: a key a recipe can name, or a sign-in its vendor allows on attended runs | no digest in the registry, as Devin |
| Kiro CLI | `kiro` 3.0.0, binary `.tar.gz` with sha256 | fits if a key, not a sign-in, carries it | plan; **unverified**: a key rather than a sign-in | its args pick an engine (`--agent-engine=v3`); tools off **unverified** |
| Kilo | `kilo` 7.8.27, binary `.tar.gz` with sha256 (also npm) | fits if its Anthropic provider takes the proxy | proxy, **unverified**: it is an OpenCode fork, whose Anthropic provider takes a base URL; tool names as the proxy wants them **unverified** | OpenCode itself is a native harness; Kilo's own tools off **unverified** |
| Poolside | `poolside` 1.0.16, binary `.tar.gz` with sha256 | fits if its key holds | plan, on the owner's Poolside key, **unverified** | tools off, resume, **unverified** |
| VT Code | `vtcode` 0.96.14, binary `.tar.gz`, no sha256 | fits if its Anthropic provider takes the proxy | proxy, **unverified**: it lists Anthropic among its providers | no digest in the registry |
| Stakpak | `stakpak` 0.3.88, binary `.tar.gz`, no sha256 | fits if its billing holds | plan or proxy, **unverified** | no digest in the registry |
| Cortex Code | `cortex-code` 1.0.73, binary `.tar.gz`, no sha256 | fits if a key can carry its account | plan, on the owner's Snowflake account, **unverified** | no digest in the registry |
| GitHub Copilot | `github-copilot-cli` 1.0.114, npm `@github/copilot` | blocked (rule 2: an npm package, no archive; rule 4: its dependencies resolve at install, which no recipe pins) | plan; its token would be saved under a name of its own and handed as `COPILOT_GITHUB_TOKEN` (rule 1) | a release as an archive would move it to "needs a workaround" at most |
| Gemini CLI | `gemini` 0.69.0, npm `@google/gemini-cli` | blocked (rule 2, as Copilot) | plan, on a key handed as `GEMINI_API_KEY`, as Antigravity's | an archive first; rule 1 holds with a key handed under the name it reads |
| Qwen Code | `qwen-code` 0.28.0, npm `@qwen-code/qwen-code` | blocked (rule 2, as Copilot) | plan, on a key handed as `OPENAI_API_KEY`, its OpenAI-compatible key | as Gemini CLI, which it forks |
| Kimi Code | `kimi-code` 2.6.3, npm `@moonshot-ai/kimi-code` | blocked (rule 2, as Copilot) | plan, on a key handed under the name it reads; **unverified**: that name | the legacy Kimi CLI above ships an archive |
| Grok Build | `grok-build` 1.0.90, npm `@xai-official/grok` | blocked (rule 2, as Copilot) | plan, on a key handed as `XAI_API_KEY` | its ACP mode is `agent stdio` |
| Cline | `cline` 3.0.74, npm `cline` | blocked (rule 2, as Copilot) | plan or proxy, **unverified** | none until an archive |
| Auggie | `auggie` 0.37.0, npm `@augmentcode/auggie` | blocked (rule 2, as Copilot) | plan, on the owner's Augment account | none until an archive |
| Factory Droid | `factory-droid` 1.14.0, npm `droid` | blocked (rule 2, as Copilot) | plan, on the owner's Factory key | its ACP mode is `exec --output-format acp-daemon` |
| Qoder CLI | `qoder` 1.1.92, npm `@qoder-ai/qodercli` | blocked (rule 2, as Copilot) | plan | none until an archive |
| Mistral Vibe | `mistral-vibe` 3.1.1, binary `.tar.gz` with sha256 | fits if its facts hold | plan, on a key saved for it alone and handed as `MISTRAL_API_KEY` (rule 1) | tools off, resume and permission asks, **unverified** |
| Amp | `amp-acp` 0.13.0, binary `.tar.gz` with sha256, a community adapter | blocked (rule 4: the adapter drives the Amp CLI, a second install no recipe names; **unverified**: whether the archive carries it) | plan, on the owner's Amp key | the second install first |
| fast-agent | `fast-agent` 0.10.1, uv `fast-agent-acp` | blocked (rule 2: a Python package, no archive) | proxy, **unverified**: it takes Anthropic's API | none until an archive |
| OpenHands | not in the ACP registry | blocked (rule 2: no registry release; it ships as a Python package and a container image) | proxy, **unverified** | a registry entry with an archive first |

Not rated: Claude Agent (`claude-acp`), Codex (`codex-acp`), OpenCode and pi, which AgentRun runs natively.

## What would move the most rows

- **A harness's own keys on a server.** A server runs a checked recipe on its proxy, or on its owner's own machine on
  their own sign-in (`--harness-sign-in`, [Run it](HARNESS.md#run-it)); every plan-billed row on a shared server waits
  on the store for a harness's own keys.
- **A live `harness-check` per row.** Ten rows fit if facts hold that one check settles; Google Antigravity's recipe
  passes it.
- **npm releases.** Ten rows ship only as an npm or uv package. A recipe would need the package's tarball with its
  integrity and every dependency locked, installed by the owner with scripts off; until then they need a harness module.
