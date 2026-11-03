---
packages: @parcha/agentrun-serve
kind: fix
---
Every agentic run's system prompt now starts with one line that says today's date and where the run works: "Today is 2026-11-03 (UTC). You are running on AgentRun; your workspace is your working directory, and file paths are relative to it." pi, claude-agent and codex get the same line. Before, pi was never told the date, so a question about the latest release was answered from the date its model was trained on ("As of March 8, 2025, ..."). The line is made again as each turn starts: on pi it is a prompt section rendered before every model request, so a run resumed on a later day is told that day; claude-agent and codex get it in the session's instructions each time the run's process opens the session.
