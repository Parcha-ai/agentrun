---
packages: @parcha/agentrun-serve, @parcha/pi-browser
kind: feature
---
A template eval case can fake the web: `web: unavailable` in its `case.yaml` fails every `web_search` with the words a rate-limited free search answers with and every `web_fetch` as a page that never answers, and `web: <fixture file>` answers each search from the first answer whose `query` (a regular expression) matches and each page from the answer for its exact URL, else the fixture's default. No call reaches the network, the calls show in the run's timeline and the graders' tool calls, so `tool_used` counts them, and the fixture is checked whole before any run.
- The same fake holds on pi, claude-agent and codex: on claude-agent and codex a faked case's runs are never offered the harness's own web search, so the run's `web_search` is the one that answers.
- Only the eval's own in-process server honours `web`; no package field, API field, setting or environment variable turns it on, and a case with `web` refuses to run with `--server`.
- Fix: a guarded public fetch of a 2xx answer with no body (204, 205) reads as an empty page instead of failing with "Cannot read properties of null".
