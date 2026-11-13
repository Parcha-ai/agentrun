---
packages: @parcha/agentrun-serve, repo
kind: fix
---
A call refused before it ran no longer reads as an error. Its `tool_result` row on `GET /v2/runs/{id}/timeline` now carries `refused: true` (an additive field: absent on every other row, `tool_status` stays `failed`). That covers a tool set to deny, a pin, a person's deny, or a call held for an approval the run stopped or ended without, on pi and on Codex and Claude Code, whose refused calls now read "Refused: …" as pi's do. The console shows it with a neutral Refused chip, never the red Error chip.
Also in the console:
- status badges keep their words on one line at their own width, so a narrow window no longer cuts "Input required";
- web_search's `auto` help names Parallel: the harness's or the model provider's own search, else Parallel where the server holds its key, else keyless Exa.
