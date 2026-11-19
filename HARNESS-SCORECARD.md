# Harness scorecard

A harness is the loop that runs an AgentRun agent. AgentRun ships five: pi, Claude Code, Codex, OpenCode and Goose. This
page reads 25 other coding agents against door 1, the recipe ([docs/harness-recipe.md](docs/harness-recipe.md)): a JSON
file that names an [Agent Client Protocol](https://agentclientprotocol.com) agent's release, which its owner installs
with `agentrun harness install --recipe` and `agentrun harness-check` runs for real. For each it says whether a recipe
alone would run it, what is in the way, and what is still open. It is for an agent vendor's engineer, or a contributor,
deciding whether to write one.

As of main `98c17062ca`, 2026-11-19, from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
of that day and the vendors' public documentation; nothing here was run on a vendor's account except Goose, whose recipe
passed `harness-check` on a model through AgentRun's proxy.

**The bar for a clean fit.** Every rule ([the five rules](docs/harness-recipe.md#the-five-rules)) holds with what's on
main, and the agent passes every stage of `agentrun harness-check` with nothing of AgentRun's run beside it but the
recipe's own files.

**Fits if** means no workaround code is left, but a fact about the agent hasn't been checked on a real run. Those facts
are marked **unverified** everywhere on this page. Most of them are lines
[`agentrun harness-check`](docs/harness-recipe.md#check-it) prints from one run: whether the agent's own tools turn off,
whether it resumes with `session/load`, whether it asks before a tool call, and what it reaches for beyond loopback.

**Needs a workaround** names the code a recipe would need that the loader, the installer or the model proxy has no
shared piece for. **Blocked** names the rule a recipe can't keep for the agent today. A row's distribution and digests
are the registry's for `linux-x86_64`.

## The table

Of 25 rows: 1 clean, 0 fit if unverified facts hold, 11 need a workaround, 13 are blocked. Two are built: Goose (on main
as a harness module, and as a recipe in this page's proof) and Cursor (a harness module on `harness/s4-cursor`, not on
main yet).

| Agent | Registry release | Fit | Billing a recipe would use | What's open |
| --- | --- | --- | --- | --- |
| Goose | `goose` 1.60.1 (main pins 1.59.2), binary `.tar.bz2` with sha256 | clean fit (built: a recipe for 1.59.2 passes `harness-check` on OpenRouter's Claude Haiku 4.5; resume `load`, tool_gate `permission`) | proxy, `GOOSE_MODEL` | the proxy's policy is Goose's own: a new Goose that sends a new `anthropic-beta` value is refused until the policy learns it. Goose titles a call of ours `agentrun: check echo`, which the ACP adapter does not tie to our tool, so the host's gate is asked about it as Goose's own (`acp_other`) before the MCP call; it asks for `models.dev:443` at every start, refused |
| Cursor | `cursor` 2026.11.13, binary `.tar.gz`, no sha256 | needs a workaround (the installer unpacks `.tar.bz2` alone); built as a harness module on `harness/s4-cursor` | plan, on the owner's own Cursor key | the registry lists no digest: the writer pins the archive, the binary's first digest is recorded and drift is refused |
| Google Antigravity | `antigravity-acp` 1.5.0, binary `.zip` with sha256 | needs a workaround (`.zip`) | plan; **unverified**: whether it takes a key or only a Google sign-in, which no recipe key carries | its args end in `--uid=`, a per-user id; **unverified** what a recipe sets there |
| Kimi CLI (legacy) | `kimi` 1.52.0, binary `.tar.gz` with sha256 | needs a workaround (`.tar.gz`) | plan; **unverified**: whether it reads a key name other than `KIMI_API_KEY` or `MOONSHOT_API_KEY`, which are the server's (rule 1) | tools off, resume and permission asks, **unverified** |
| Devin | `devin` 3000.14.30821, binary `.tar.gz`, no sha256 | needs a workaround (`.tar.gz`) | plan, on the owner's Devin account; **unverified**: a key a recipe can name | no digest in the registry: the writer pins the archive, the first binary digest is recorded |
| Junie | `junie` 4100.8.0, binary `.zip`, no sha256 | needs a workaround (`.zip`) | plan, on the owner's JetBrains account; **unverified**: a key a recipe can name | no digest in the registry, as Devin |
| Kiro CLI | `kiro` 3.0.0, binary `.tar.gz` with sha256 | needs a workaround (`.tar.gz`) | plan; **unverified**: a key rather than a sign-in | its args pick an engine (`--agent-engine=v3`); tools off **unverified** |
| Kilo | `kilo` 7.8.27, binary `.tar.gz` with sha256 (also npm) | needs a workaround (`.tar.gz`) | proxy, **unverified**: it is an OpenCode fork, whose Anthropic provider takes a base URL; tool names as the proxy wants them **unverified** | OpenCode itself is a native harness; Kilo's own tools off **unverified** |
| Poolside | `poolside` 1.0.16, binary `.tar.gz` with sha256 | needs a workaround (`.tar.gz`) | plan, on the owner's Poolside key, **unverified** | tools off, resume, **unverified** |
| VT Code | `vtcode` 0.96.14, binary `.tar.gz`, no sha256 | needs a workaround (`.tar.gz`) | proxy, **unverified**: it lists Anthropic among its providers | no digest in the registry |
| Stakpak | `stakpak` 0.3.88, binary `.tar.gz`, no sha256 | needs a workaround (`.tar.gz`) | plan or proxy, **unverified** | no digest in the registry |
| Cortex Code | `cortex-code` 1.0.73, binary `.tar.gz`, no sha256 | needs a workaround (`.tar.gz`) | plan, on the owner's Snowflake account, **unverified** | no digest in the registry |
| GitHub Copilot | `github-copilot-cli` 1.0.114, npm `@github/copilot` | blocked (rule 2: an npm package, no archive; rule 4: its dependencies resolve at install, which no recipe pins) | plan; its token `COPILOT_GITHUB_TOKEN` is the server's (rule 1); **unverified**: whether it reads another name | a release as an archive would move it to "needs a workaround" at most |
| Gemini CLI | `gemini` 0.69.0, npm `@google/gemini-cli` | blocked (rule 2, as Copilot; rule 1: it reads `GEMINI_API_KEY`, the server's) | plan | a per-harness key name mapped onto the one it reads would clear rule 1 |
| Qwen Code | `qwen-code` 0.28.0, npm `@qwen-code/qwen-code` | blocked (rule 2, as Copilot; rule 1: its OpenAI-compatible key is `OPENAI_API_KEY`, the server's) | plan | as Gemini CLI, which it forks |
| Kimi Code | `kimi-code` 2.6.3, npm `@moonshot-ai/kimi-code` | blocked (rule 2, as Copilot) | plan; **unverified**: its key name, beside the server's `KIMI_API_KEY` and `MOONSHOT_API_KEY` | the legacy Kimi CLI above ships an archive |
| Grok Build | `grok-build` 1.0.90, npm `@xai-official/grok` | blocked (rule 2, as Copilot; rule 1: `XAI_API_KEY` is the server's) | plan | its ACP mode is `agent stdio` |
| Cline | `cline` 3.0.74, npm `cline` | blocked (rule 2, as Copilot) | plan or proxy, **unverified** | none until an archive |
| Auggie | `auggie` 0.37.0, npm `@augmentcode/auggie` | blocked (rule 2, as Copilot) | plan, on the owner's Augment account | none until an archive |
| Factory Droid | `factory-droid` 1.14.0, npm `droid` | blocked (rule 2, as Copilot) | plan, on the owner's Factory key | its ACP mode is `exec --output-format acp-daemon` |
| Qoder CLI | `qoder` 1.1.92, npm `@qoder-ai/qodercli` | blocked (rule 2, as Copilot) | plan | none until an archive |
| Mistral Vibe | `mistral-vibe` 3.1.1, binary `.tar.gz` with sha256 | blocked (rule 1: it reads `MISTRAL_API_KEY`, the server's), and `.tar.gz` | plan | a per-harness key name, as Gemini CLI, and the archive format |
| Amp | `amp-acp` 0.13.0, binary `.tar.gz` with sha256, a community adapter | blocked (rule 4: the adapter drives the Amp CLI, a second install no recipe names; **unverified**: whether the archive carries it) | plan, on the owner's Amp key | the archive format as well |
| fast-agent | `fast-agent` 0.10.1, uv `fast-agent-acp` | blocked (rule 2: a Python package, no archive) | proxy, **unverified**: it takes Anthropic's API | none until an archive |
| OpenHands | not in the ACP registry | blocked (rule 2: no registry release; it ships as a Python package and a container image) | proxy, **unverified** | a registry entry with an archive first |

Not rated: Claude Agent (`claude-acp`), Codex (`codex-acp`), OpenCode and pi, which AgentRun runs natively.

## What would move the most rows

- **`.tar.gz` and `.zip` in the installer.** Eleven rows need only that, before their unverified facts are checked:
  `installArchive` unpacks `.tar.bz2` alone today.
- **A per-harness key name mapped onto the one the agent reads.** Rule 1 refuses a recipe that names a key the server
  holds for itself (`GEMINI_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, ...). Saving the owner's key under the
  harness's own name and handing it to the agent under the vendor's name would clear rule 1 for five rows.
- **npm releases.** Ten rows ship only as an npm or uv package. A recipe would need the package's tarball with its
  integrity and every dependency locked, installed by the owner with scripts off; until then they need a harness module.
