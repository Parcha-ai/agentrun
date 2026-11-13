---
packages: @parcha/agentrun-computer
kind: breaking
---
The computer protocol 0.2's follow-up: a driver whose hello lacks a group its kind needs is refused, `apps.launch` answers once the app has a window, and `ui.act` waits for windows, follows them when one closes, and answers a `set` verified only when its value holds. Breaking: `UiActResult.state` is optional; an act whose app has no window left answers `window: "closed"` with no state.
- `kindServed(hello)` answers the groups a hello lacks for its kind (a desktop needs `screen`, `input.pointer` and `input.keys`; a phone `screen`, `input.touch` and `apps`). The attach binding closes such a driver `4426` naming them, and the Core case `health.kind-served` fails it.
- `DAEMON_METHODS` lists every method the daemon answers.
- `apps.launch` answers once the app shows a window, or fails `timeout` naming the app after `LAUNCH_WINDOW_MS` (10 s); the Core case `apps.launch-window` observes right after the launch. The fake ui driver takes `windowAfterMs`.
- A node's bounds are clamped to its window (`insideWindow`).
- A settle compares the window's nodes, and its image only when it has none, so a blinking caret no longer holds every act to `MAX_SETTLE_MS`.
- A `set` answers `verified: true` only when its value still holds `SET_HOLD_MS` (500 ms) after the settle.
- `expect.window` (`{title?, role?}`) waits for a window of the act's app and answers its state; none in time is `unmet`. `UiWindow` gains `role` (`"dialog"` for a sheet, alert or panel).
- A step that closes the act's window hands the act to its app's next main window; with none left the act answers `window: "closed"`.
- The ui fixture gains "New window", "Close" and a "Code" field that takes its value back, with the Full cases `ui.settle-tree`, `ui.set-holds`, `ui.expect-window`, `ui.window-closed` and `ui.window-follow`. A fixture with one window per app leaves out "New window", and the window cases skip.
