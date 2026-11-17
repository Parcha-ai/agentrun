---
packages: repo
kind: docs
---
The setup skill (`docs/SKILL.md`) is the one setup prompt, ordered for a finished first run in about five minutes. The website serves the same text at https://agentrun.ai/SKILL.md.
- It reads the session first and says up front when it is a hosted cloud session or sandbox the person's browser can't reach (Claude Code's cloud sessions on the web and in the desktop app, or a Linux container with no display, as a Codex cloud task is). There it recommends AgentRun Cloud or a one-click deploy and installs only if the person still asks. The check prints the names of the signals it finds, never their values.
- It asks where AgentRun should run before any install or deploy command. There are five places, each with its cost: this computer (free), the person's own always-on machine over Tailscale (free), Railway (about $5 a month), Render (about $27.50 a month, no shell for agents) and AgentRun Cloud. A signed-in provider CLI, a deploy button or `render.yaml` is still never a choice.
- The model step offers Continue with ChatGPT first and a capped key as the fallback, both saved in the console, never in the chat.
- The assistant creates a no-tool "Release notes" agent with `agents create`, shows its model and $0.25 cap, and on the person's OK starts the first run with `runs start --wait`. It hands over the run's console link once the run has finished. The person fills in no form.
- Finding the Claude Code and Codex jobs a person already runs (cron, systemd timers, launchd, CI) moved after the first run, as an offer.
- `README.md` and `docs/getting-started.md` tell a coding agent to "set up AgentRun for me" rather than "locally".
