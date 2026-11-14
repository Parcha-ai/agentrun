---
packages: @parcha/agentrun-computer, @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A desktop with no ui group (E2B's, Agent37's) can be driven by the tools alone, and its first screen no longer reads as broken.
- `computer_observe` and `computer_act` with `app` open that app, or bring it in front, before the screenshot or the input (apps.launch, as a script's `computer.apps.open` does). A screenshot with no app in front lists the app ids to name. Before, a tools-only agent had no way to open an app there.
- The desktop's background is one slate colour (xsetroot, run before xfwm4), not black. Agent37's desktop recipe (`box/build-agent37.mjs`) adds x11-xserver-utils for it; rebuild `agentrun-box` once.
- `computer_act` offers no `expect` on a desktop with no ui group, which can't check one: its schema there has none, so a model is no longer offered a wait that is then refused.
- `GET /v2/runs/{run_id}/computer` on an ended run says `session: "closed"` for its desktop or phone, and for a browser step the run ended under, not `opening`.
- A provider's label takes its article: "an E2B sandbox", not "a E2B sandbox".
