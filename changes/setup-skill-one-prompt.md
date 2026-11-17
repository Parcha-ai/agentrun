---
packages: repo
kind: docs
---
The setup skill (`docs/SKILL.md`) is the one setup prompt, ordered for a finished first run in about five minutes. The website serves the same text at https://agentrun.ai/SKILL.md.
- Every choice is a question asked with the host's question tool (Claude Code's `AskUserQuestion`, Codex's `request_user_input`, Cursor's `AskQuestion`, OpenCode's `question`), with the recommended option first and the reason for it. A host with no such tool gets a numbered question and the assistant stops until the person answers.
- It reads the session first and says up front when it is a hosted cloud session or sandbox the person's browser can't reach. There the hosted option comes first. The check prints the names of the signals it finds, never their values.
- Its first call asks two questions before any install or deploy: where AgentRun should run (this computer, the person's own always-on machine over Tailscale, or a hosted service, then Railway, Render or AgentRun Cloud, each with its cost), and whether to look read-only for the Claude Code and Codex jobs the person already schedules. A signed-in provider CLI, a deploy button or `render.yaml` is still never a choice.
- A job it finds becomes the first run: connected on its own sign-in, its history imported with no model key, then run once through AgentRun on the person's OK.
- With no job to bring in, the model step offers Continue with ChatGPT, then a capped OpenRouter key, then a local Ollama or LM Studio model when one with tool calling is already pulled. A key from the Claude Console organization linked to a Claude Max, Ultra or Team plan uses that plan's monthly API credits.
- The template agent names `"place": {"mode": "runner"}`, and `"thinking": "low"` on a local model, so its first run starts at once and its answer carries no reasoning.
- `README.md` and `docs/getting-started.md` tell a coding agent to "set up AgentRun for me" rather than "locally".
