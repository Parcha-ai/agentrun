---
packages: @parcha/agentrun-harness-acp, @parcha/agentrun-serve, @parcha/agentrun
kind: feature
---
Cursor runs as a harness (`cursor`), over ACP, on its owner's own Cursor API key: install its pinned release with `agentrun harness install cursor` (or `agentrun-serve install-harness cursor`), set `CURSOR_API_KEY` where AgentRun starts, and restart. Each run is billed to your Cursor plan, under Cursor's terms, with no spend cap of AgentRun's: it stops after 20 turns or 100 tool calls (`AGENTRUN_CURSOR_MAX_TURNS`, `AGENTRUN_CURSOR_MAX_TOOL_CALLS`), and capabilities show its card (`harnesses[].card`).
- Cursor makes no file edits: every Write is denied in its CLI config until Cursor asks before an edit, as it asks before a shell command or a tool. Shell commands and AgentRun's tools over MCP go through the agent's tool settings.
- `CURSOR_API_KEY` is handed to Cursor's runs alone, read by name at each start; the credential Cursor derives from it (`auth.json`) and its whole private HOME are deleted when its process ends.
- A model is `cursor/<model-id>` (`cursor/gpt-5.4-nano`; `cursor/default` for Cursor's own default), checked against the models Cursor lists for the key (`ACP_MODEL_UNLISTED`). A key whose Cursor team administrator turned headless CLI use off is refused as `CURSOR_HEADLESS_DISABLED`.
- The release is pinned by its archive's sha256, its launcher's, and a digest of every file it unpacks to; a drift in any of them refuses the run (`ACP_BINARY_MISMATCH`). The archive installer takes tar.gz as well as tar.bz2.
