---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
The computer protocol 0.2's follow-up: create is idempotent by a required request id, a driver whose hello lacks a group its kind needs is refused, `apps.launch` answers once the app has a window, and `ui.act` waits for windows, follows them when one closes, and answers a `set` verified only when its value holds. Breaking: `ComputerProvider.create` takes a required context, `{ requestId }`; `UiActResult.state` is optional, and an act whose app has no window left answers `window: "closed"` with no state.
- Idempotent create (`CreateContext`, `computerNameFor`): one computer per request id, named `computer-<12 hex of sha256(request id)>`; the same id while it starts or runs answers it, and after it ended is refused `exists`. Serve passes the run's claim (`<run>.<epoch>`). The Full cases `provider.create-retried` and `provider.create-after-release` check it; the fake ui provider and the attached provider keep it, and a fake ui computer's network is fixed at create (a change is `refused`).
- The refusal kinds are `ComputerErrorCode`, with `vendor` the only open one: `invalid` is a malformed request, `unsupported` a call or feature the provider lacks, `refused` a value or state it does not serve, such as a network change after create on a remote computer.
- `kindServed(hello)` answers the groups a hello lacks for its kind (a desktop needs `screen`, `input.pointer` and `input.keys`; a phone `screen`, `input.touch` and `apps`). The attach binding closes such a driver `4426` naming them, and the Core case `health.kind-served` fails it.
- `DAEMON_METHODS` lists every method the daemon answers.
- `apps.launch` answers once the app shows a window, or fails `timeout` naming the app after `LAUNCH_WINDOW_MS` (10 s); the Core case `apps.launch-window` observes right after the launch. The fake ui driver takes `windowAfterMs`.
- A node's bounds are clamped to its window (`insideWindow`).
- A settle compares the window's nodes, and its image only when it has none, so a blinking caret no longer holds every act to `MAX_SETTLE_MS`.
- A `set` answers `verified: true` only when its value still holds in the act's final view: at least `SET_HOLD_MS` (500 ms) after the settle, and after the expect's last settle. A set's hold, the expect and the answered state all read that one view.
- `expect.window` (`{title?, role?}`) waits for the act's app's main window to match, from its first look (never the window a target or state aimed at), and answers its state; none in time is `unmet`. `UiWindow` gains `role` (`"dialog"` for a sheet, alert or panel).
- A step that closes the act's window hands the act to its app's next main window; with none left the act answers `window: "closed"`.
- The fake ui driver's windows are its own objects: each owns its screen, history, values, switches, focus and pending effects, and closing one cancels its effects.
- The ui fixture gains "New window", "Close" and a "Code" field that takes its value back, with the Full cases `ui.settle-tree`, `ui.set-holds`, `ui.expect-window`, `ui.window-closed` and `ui.window-follow`. A fixture with one window per app leaves out "New window", and the window cases skip.
