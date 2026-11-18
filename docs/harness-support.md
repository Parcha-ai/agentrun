# Harness support and integration priorities

AgentRun can receive reports from an agent without launching or controlling it. Keep three claims
separate: **external reporting** records an externally owned run; **managed execution** launches and
controls a harness; **learning integration** supplies evidence to AgentRun's compiler and delivers an
accepted result to a subsequent run. A source name, model-provider entry, or ACP handshake alone does
not establish all three.

## Support snapshot

This baseline records main at `71ecc345d` and the pending changes below. Recheck their status before
treating a proposal as released support.

| Surface | What it provides | Boundary |
| --- | --- | --- |
| Managed harnesses: Pi, Claude Agent, Codex, OpenCode | Built-in runner, installation and capability paths | See [harness registry](../packages/serve/src/harness.ts) and [runtime table](../packages/serve/src/harness-table.ts). Existing support, not missing connectors. |
| Native connect: Claude Code, Codex | Source-preserving connection and execution | Keep the external installation and its policy; capabilities depend on the selected runtime. |
| History import: Claude Code, Codex, Pi | Reads existing sessions | [Supported sources](../packages/serve/src/import-sources.ts). Import alone does not prove later learning consumption. Cursor handoff links are a separate surface, not connected execution. |
| Generic ACP adapter | Held transport/conformance seam | A successful initialize handshake is not a registered real-harness integration or learning proof. |
| Backend sources: `claude-agent-sdk`, `codex-sdk` | SDK run reporting | Keep external ownership and supported control capabilities explicit. |
| OpenClaw and Capy, [PR #3066](https://github.com/Parcha-ai/agentrun/pull/3066) | Pending external SDK-run sources and event/usage reporting | Not platform launch, console stop/cancel, or workflow-tools support. Its original learned-notes/skills behavior must be reconciled with the current compiler contract. |
| Goose ACP, [PR #3150](https://github.com/Parcha-ai/agentrun/pull/3150) | Pending integration | Reuse and review this work; do not build a competing connector. |
| Eve, [PR #3121](https://github.com/Parcha-ai/agentrun/pull/3121) | Pending integration | Review the PR's actual capability and learning evidence before assigning support. |

Main's learning contract changed in [PR #3097](https://github.com/Parcha-ai/agentrun/pull/3097): workflow
compilation and owner corrections replace the earlier learned-notes/skills, grader, and lookback
machinery. Native memory and skills in another harness remain that harness's own state. An external
reporting source cannot execute autonomous workflows merely because AgentRun accepts its events.

## CLI candidates

Primary-source research began November 16; the main matrix and GitHub repository counts were refreshed on **November 18, 2026**. Rounded GitHub stars
measure public repository interest, not active users, installations, or integration quality. Closed
products and newly split repositories are not comparable on that measure. Priorities also consider
documented APIs, preservation of existing configuration, and the cost of proving a second run uses
accepted learning. The delivery mechanisms below are **proposals**, not completed AgentRun support.

| Candidate; stars | Integration path | Additive delivery; native state | Limitations and priority |
| --- | --- | --- | --- |
| [Hermes](https://github.com/NousResearch/hermes-agent); 264.3k | Official `hermes acp` stdio transport. [Guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) | Prompt context or namespaced external skills; preserve native memory snapshots and skill catalog. [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) | **Next CLI batch.** Verify gateway cancellation and reconnect separately from viewer-process exit. Avoid concurrent writers to one Hermes home. External skill directories are not inherently read-only. |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli); 108.9k | Headless `--output-format stream-json` supplies session/message/tool/result events and usage; native ACP is available. [Headless](https://geminicli.com/docs/cli/headless/), [ACP](https://geminicli.com/docs/cli/acp-mode/) | Add task context or an explicitly managed `GEMINI.md` import; namespaced skills are supported. [Context](https://geminicli.com/docs/cli/gemini-md/), [skills](https://geminicli.com/docs/cli/skills/) | **API-key/enterprise batch after Hermes.** Individual free/Pro/Ultra accounts moved to Antigravity on June 18; enterprise Code Assist and API-key authentication remain available. [Official transition](https://github.com/google-gemini/gemini-cli/discussions/28017). Preserve approval policy; distinguish warnings from terminal failures and aggregate from per-model usage. `GEMINI_SYSTEM_MD` replaces the built-in prompt, so avoid it for additive delivery. [Override](https://geminicli.com/docs/cli/system-prompt/) |
| [Antigravity CLI](https://antigravity.google/docs/); no comparable repository count | Separate Google terminal harness; verify its current headless/event and cancellation contract before an adapter. [Changelog](https://antigravity.google/changelog?tab=cli) | Migration preserves Gemini memory, skills and MCP configuration; preserve that state when adding learning. [Transition](https://github.com/google-gemini/gemini-cli/discussions/28017) | **Discovery alongside Gemini.** Do not assume Gemini CLI protocol compatibility or mark it supported because configuration migrates. |
| [GitHub Copilot CLI](https://github.com/github/copilot-cli); 11.4k | Official SDK exposes sessions, event subscriptions/history, abort, resume, and usage events. [Compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility) | `systemMessage` append mode and `skillDirectories` preserve native instructions and skills. | **Following batch.** Gate cancel, resume, and workflow tools independently; upstream availability does not establish AgentRun support. |
| [Cline](https://github.com/cline/cline); 71.7k | CLI JSON/ACP or official SDK runtime events. [CLI](https://docs.cline.bot/cli/cli-reference), [ACP](https://docs.cline.bot/usage/acp), [SDK](https://github.com/cline/cline/blob/main/sdk/README.md) | Task context and namespaced `.cline/skills`; preserve rules and existing skills. [Skills](https://docs.cline.bot/customization/skills) | **Following batch.** Supplied CLI prompts default to auto-approval: explicitly retain the selected policy. A newly constructed SDK agent is not necessarily the user's configured Cline. Avoid skill-name collisions. |
| [OpenHands](https://github.com/OpenHands/OpenHands); 93.7k | Software Agent SDK conversations and callbacks, or documented agent-server APIs. [SDK](https://github.com/OpenHands/software-agent-sdk) | `AgentContext.system_message_suffix` and explicit skills; leave opt-in native memory unchanged. [Context](https://docs.openhands.dev/sdk/guides/skill), [memory](https://docs.openhands.dev/sdk/guides/persistent-memory) | **Following framework batch.** Native memory is off by default. Pause may wait for the current model call; do not promise immediate cancellation. [Implementation](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py) |
| [Goose](https://github.com/aaif-goose/goose); 56.7k | ACP and headless structured output. [CLI](https://goose-docs.ai/docs/guides/goose-cli-commands/) | Task context and namespaced `.agents/skills`; retain native memory extension and instructions. [Skills](https://goose-docs.ai/docs/guides/context-engineering/using-skills/) | **Coordinate with #3150.** Keyring access can block unattended runs. Pin and test usage and terminal-event semantics. Repository moved from `block/goose` to `aaif-goose/goose`. |
| [Qwen Code](https://github.com/QwenLM/qwen-code); 30.7k | Headless JSON/stream-JSON and SDK transports. [Headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/) | `--append-system-prompt` is additive; namespaced skills coexist with `QWEN.md` and native memory. [Skills](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/), [memory](https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/) | **Later batch.** Native memory work may outlive the terminal result; do not kill the process immediately. Safe mode disables native memory and other configuration. |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code); 8.2k | Current Node CLI headless stream-JSON, ACP, or documented local server API. [CLI](https://moonshotai.github.io/kimi-code/en/reference/kimi-command), [ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html) | Task context, namespaced skills, or additive `extra_skill_dirs`. [Skills](https://moonshotai.github.io/kimi-code/en/customization/skills) | **Later batch.** Target current `@moonshot-ai/kimi-code`; [legacy Python CLI](https://github.com/MoonshotAI/kimi-cli) is archived (11.4k stars). `--skills-dir` replaces automatic discovery, so can hide native skills. [Migration](https://moonshotai.github.io/kimi-code/en/guides/migration) |

Also surveyed: [Aider](https://github.com/Aider-AI/aider) (50.2k stars) has documented CLI scripting,
but its [Python scripting API](https://aider.chat/docs/scripting.html) is explicitly unstable;
structured event/usage coverage needs investigation. [Amp's SDK](https://ampcode.com/docs/sdk) and
[execute mode](https://ampcode.com/docs/cli/execute-mode) are candidates, with distinct local and remote
lifecycles and no comparable usage metric verified here. [Roo Code](https://github.com/RooCodeInc/Roo-Code)
(24.2k stars) is archived, so a new integration is lower priority absent a maintained successor.

## Framework SDK lane

These are application frameworks, not interchangeable coding CLIs. Stars refer to the named repository;
the JavaScript-specific counts do not measure the entire Python/JavaScript ecosystem. OpenAI Agents SDK
is distinct from Codex SDK. All rows remain unshipped proposals relative to the main snapshot above.

| Framework; stars | Native integration and memory | AgentRun status and proposed delivery | Priority and boundary |
| --- | --- | --- | --- |
| [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js); 4.0k | Native Runner, model input filters, tool events, sessions and MCP. [Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/) | First draft batch: explicit wrapper around the native run path; owner corrections and pinned workflow context; host attaches the existing MCP bridge. | **First batch.** Narrow to fresh text/nonstreamed tasks; preserve Agent, native memory, guardrails and tools. Python, voice and Codex are separate contracts. |
| [LangGraph JS](https://github.com/langchain-ai/langgraphjs); 3.4k | Graph invocation and callbacks; checkpointers hold short-term state, stores long-term memory. [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | First draft batch: `withLangGraphLearning`, host-defined input/answer adapters, explicit bridge tool in the original graph. Native two-run compile/version/execute proof passes offline. | **First batch.** Fresh `invoke` only. Existing checkpoints, streaming and resume are gated; Python requires its own adapter. |
| [Deep Agents](https://github.com/langchain-ai/deepagents); 31.4k | LangChain/LangGraph-based framework with planning, files, subagents and memory. [Overview](https://docs.langchain.com/oss/javascript/deepagents/overview), [memory](https://github.com/langchain-ai/docs/blob/main/src/oss/deepagents/memory.mdx) | Not yet integrated. Reuse the LangGraph seam only after native Deep Agents conformance; inject namespaced context or an explicit bridge without replacing filesystem backends or memory middleware. | **Following framework batch.** A LangGraph wrapper does not prove Deep Agents CLI, managed service, subagent accounting or Python compatibility. |
| [Google ADK](https://github.com/google/adk-python); 22.3k | Agent/model/tool callbacks plus session and memory services. [Callbacks](https://adk.dev/callbacks/types-of-callbacks/), [memory](https://adk.dev/sessions/memory/) | Not integrated. Compose callbacks for evidence and reference injection; use explicit tool delegation for workflows while preserving the application's services. | **Following framework batch.** Pin language and ADK version; multi-agent callbacks must not duplicate lifecycle or usage. ADK is separate from Gemini/Antigravity CLI. |
| [Mastra](https://github.com/mastra-ai/mastra); 29.6k | `generate`/`stream`, processors and persisted memory with per-call context. [Processors](https://mastra.ai/docs/agents/processors), [memory](https://mastra.ai/docs/memory/overview) | Not integrated. A wrapper/processor can capture evidence and add reference context; preserve memory, thread/resource identity and existing processors. | **Following framework batch.** Verify processor order, retry/cached-response accounting, cancellation and stream finalization with the actual framework. |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai); 21.3k | `run`/`iter`, typed results, usage and explicit message history. [Agent API](https://pydantic.dev/docs/ai/api/pydantic-ai/agent/), [history](https://github.com/pydantic/pydantic-ai/blob/main/docs/message-history.md) | Not integrated. Extend the Python client with an explicit run wrapper and toolset bridge; leave dependencies, validation, history and durability in the host. | **Following Python batch.** Typed output is not necessarily public prose. Preserve tool approvals and distinguish native retries from repeated externally charged work. |

The first SDK batch reuses the source registry from OpenClaw/Capy #3066 rather than creating another
reporting protocol. Their current distinction is capability: the platform proposal records externally
owned runs, while these wrappers additionally connect the native model and an explicitly configured
workflow tool. All use the same receipt, evidence, completion and learning contracts.

Prioritization is an engineering judgment, not a market-share ranking: the two JavaScript wrappers
provide a bounded, reproducible integration with existing client APIs and no native binary lifecycle.
Hermes is the next CLI candidate; coordinate Goose with #3150 and Eve with #3121. Before calling any
new path supported, require the native two-run evidence below. See the [framework cookbook](tutorials/framework-sdk-learning.md).

## Acceptance evidence

An integration needs evidence beyond protocol initialization:

1. Run one emits realistic session, text, tool, terminal, and available usage events; compiler inputs
   retain their provenance. Duplicate events and completion retries do not duplicate evidence or usage.
2. The resulting workflow passes the current checks and is committed; pending artifacts receive owner
   approval before serving. Corrections remain owner-supplied. Run two receives that exact accepted version. Test captured provider input and the
   relevant execution path; a skill catalog entry alone does not prove its content was consumed.
3. Unaccepted results are not delivered. The integration leaves preexisting native memory, skills,
   provider configuration, and permission policy intact.
4. Errors and disconnects preserve partial evidence. Unknown usage remains unknown; cumulative and
   incremental counters are handled separately. Never blindly retry an uncertain side effect.
5. Cancellation requires acknowledgment from the actual execution owner, or is exposed as
   unsupported. Gate resume and workflow tools independently. Reporting-only sources must reject
   operations they cannot perform.
6. Shared scripted conformance proves AgentRun behavior; pinned real-harness tests prove upstream
   compatibility. Report passed, failed, skipped, and unrun checks separately. A simulated two-run
   test does not establish live platform compatibility.
