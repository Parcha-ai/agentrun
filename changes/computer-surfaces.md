---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve, @parcha/agentrun-computer, @parcha/agentrun-harness-codex
kind: breaking
---
Every harness sees a desktop or a phone through one surface: the tools `computer_observe`, `computer_act`, `computer_screenshot` and `computer_script`, the same answers from a script, an MCP client or a tool call. Breaking: the `desktop_*` and `phone_*` tools are gone, replaced by the `computer_*` tools (a desktop's and a phone's alike, held to the `desktop` or `phone` setting), and the script API's `apps.open(id)` returns nothing; bind the app with `computer.app(id)`.
- `computer_script` runs JavaScript in an isolate in serve whose only binding is `computer` (no network, no keys, no timers); its types are `spec/computer/computer.d.ts`, generated with the tools' schemas by `scripts/generate-computer-surface.mjs` (`--check` in CI).
- pi offers its code mode (`codemode`) beside its tools with a desktop or a phone, `computer` bound in its scripts; the call is held to the computer kind's setting.
- In Codex's code mode a script's call of a computer tool answers the tool's value as JSON, its images' data in it; any other tool's images now reach the script as data: URLs.
- agentrun-serve's `computerMcp` serves a run's computer tools to an MCP client, each answer with `structuredContent`.
- The desktop-computer and phone-computer skills teach the route: observe, act by ref, check, and one script for steps already known.
