# The wire

The methods a computer answers, as [JSON-RPC 2.0](https://www.jsonrpc.org/specification). Each method's params and
result are in [`schema/methods.schema.json`](schema/methods.schema.json); the numbers below are in
[`protocol.json`](protocol.json). Both are generated from the code, and they are the authority where this page is
shorter.

## Methods

A computer answers the methods of the groups it declares (see [`kinds.md`](kinds.md#groups)), and `hello` and `ping`
always.

| Group | Methods |
| --- | --- |
| (always) | `hello`, `ping` |
| `exec` | `exec.run`: one program, from argv (never a shell string), to its end, with its output |
| `files` | `files.read`, `files.write`, `files.stat`, `files.list`, `files.mkdir`, `files.move`, `files.remove`; `tar.pull.begin`, `tar.pull.read`, `tar.pull.end`, `tar.push.begin`, `tar.push.write`, `tar.push.end` |
| `processes` | `process.start`, `process.read`, `process.write`, `process.signal`, `process.resize`, `process.list`, `process.wait`: programs that outlive the call |
| `screen` | `screen.shot`, `screen.read`, `screen.watch` |
| `input.pointer`, `input.keys`, `input.touch` | `input.actions`: a batch of pointer, key and touch actions, each allowed by its group |
| `apps` | `apps.list`, `apps.launch`, `apps.terminate` |
| `apps.install` | `apps.install` |
| `ui` | `ui.observe`, `ui.act`: one app's window as named elements, and short lists of steps on it ([below](#the-ui-group)) |
| (a computer whose daemon keeps its deadline) | `deadline.extend` |
| (a computer with a synced disk mounted) | `mount.sync` |

A method a computer does not have is an error of kind `unsupported`, in words; the connection goes on.

## hello

`hello` is the first call on a connection. Its result says what the computer is:

```json
{"protocol":"0.2","version":"0.1.0-beta.31","os":"linux","kind":"linux","arch":"arm64","groups":["exec","files","processes"]}
```

A computer with the `ui` group also says its screen and its features:

```json
{"protocol":"0.2","version":"0.2.0","os":"macos","kind":"desktop","arch":"arm64","groups":["screen","input.pointer","input.keys","apps","ui"],
 "screen":{"width":1512,"height":982,"scale":2},
 "osVersion":"26.1 (25B78)","device":{"maker":"Apple","model":"MacBook Pro"},
 "features":{"ui.tree":true,"ui.image":true,"ui.background":true,"ui.foreground":true,"ui.page":{"off":"Safari's automation is off in its Develop menu"},"ui.nav":{"off":"a Mac has no system back, home or app switch"},"apps.background":true}}
```

- `protocol`: the version of this protocol the computer speaks. A caller refuses a computer that speaks another.
- `version`: the daemon's own version, or with daemon `none` the provider's. A provider refuses a daemon of a version
  other than its own (a drifted daemon is never handed out).
- `os`, `kind`, `arch`: what the computer is (see [`kinds.md`](kinds.md)). `arch` is Go's name: `amd64`, `arm64`.
- `groups`: what it offers. It must be what the provider declared for it (`capabilities().groups`). `cdp`, `stream` and
  `downloads` are the provider's and never appear in a daemon's `hello`. `groups` holds every group the kind requires
  to be given to an agent ([`kinds.md`](kinds.md)): a `desktop` lists `screen`, `input.pointer` and `input.keys`
  whatever else it offers. `kindServed(hello)` names the ones missing, the case `health.kind-served` fails a computer
  that lacks one, and an attached computer that lacks one is closed at connect ([`attach.md`](attach.md)).
- `display`: a desktop's X display, such as `":99"`; absent elsewhere.
- `fence`: how init holds its programs off the computer's network when it gave them one of their own
  (`init --own-network`): `"netns"`, a network namespace root made, or `"userns-netns"`, one made inside a user
  namespace of its own where root may not make one. Absent when its programs have no network of their own. A provider
  whose computers' programs must have a network of their own refuses a `hello` without it.
- `screen`: the main screen's size in points and its scale (pixels per point). Present with the `ui` group.
- `features`: what the computer can and cannot do inside its groups, each name `true`, or `{"off": "<why, in words>"}`.
  A feature that is off is refused with that sentence when asked for, never ignored. The names and what they mean are
  `features` in [`protocol.json`](protocol.json): `screen.capture`, `ui.tree`, `ui.image`, `ui.background`,
  `ui.foreground`, `ui.page`, `ui.nav` and `apps.background`. Names stay the same on every OS; an OS name appears only
  in a reason. A computer of the `ui` group always declares `ui.tree`. A feature not declared is not offered, but for
  `screen.capture`: a computer of the `screen` group that does not declare it captures its screen, and one that declares
  it off refuses `screen.shot` and `screen.watch` with its reason (an attached Mac whose owner has not granted the
  screen, [`kinds.md`](kinds.md)).
- `osVersion`: the OS's version as the computer says it, with its build when the driver knows it: `"15 (API 35)"`,
  `"26.1 (25B78)"`.
- `device`: the machine, `{"maker": "Apple", "model": "MacBook Pro"}`. The same fields on every OS; its CPU is `arch`.

## Requests, replies and order

- Requests run at once. Replies may come in any order: a caller matches each by its `id`.
- A caller sends only the params the schema gives: each method's params object is closed
  (`additionalProperties: false`), a map such as `exec.run`'s `env` holds strings only, and a number is a whole number
  (`integer`) except an `input.actions` scroll's `dx` and `dy` in pixels and a pinch's `scale`.
- `computerd` refuses anything else: an unknown field, or a value of the wrong type, is an error of kind `invalid`. A
  provider that answers the methods in its own process (daemon `none`: a phone, a browser) may ignore an unknown field
  instead, so a caller never relies on that refusal.
- `hello` and `ping` are the exceptions, in the schema and in `computerd`: they take any params and read none. A client
  learns what a computer speaks from `hello`, so a newer client's `hello` is never refused for a field this computer
  doesn't know.
- Bytes travel as base64: `exec.run`'s `stdout` and `stderr`, a file's data, a screen's image.
- Large reads come in chunks of at most `maxChunkBytes`. `files.read` reads a file by offset and length. `screen.shot`
  and `screen.watch` carry an image's first chunk and an `id`, and `screen.read` reads the rest by that id and offset.
  `tar.pull.*` and `tar.push.*` stream an archive by begin, read or write, and end.

## Cancellation

A caller cancels a request with the notification `$/cancelRequest` and params `{"id": <the request's id>}`.

- The request ends with an error of kind `aborted` (JSON-RPC code `-32800`).
- An `exec.run` that is cancelled, or that times out, has its whole process tree ended: a group SIGTERM, then SIGKILL
  2 s later. A timeout is a result with `timedOut: true`, not an error.
- When the input ends, every request still running on that connection is cancelled. A process started by
  `process.start` is not: it outlives the connection.

## Errors

An error reply is JSON-RPC's, with the protocol's kind in `data`:

```json
{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"no such file: /workspace/notes.txt","data":{"kind":"not_found"}}}
```

- `message` is words a person can act on. It never holds a key, a token or a secret.
- `data.kind` is one of `not_found`, `invalid`, `timeout`, `aborted`, `denied`, `limit`, `unsupported`, `exists`,
  `not_dir`, `is_dir`, `stale`, `refused` (`errorKinds` in [`protocol.json`](protocol.json)). A caller acts on the
  kind, never on the message. `stale` is the `ui` group's: a ref whose element is gone, or a point whose window
  changed under it. `invalid` is a request malformed whatever the computer; `unsupported` a method or feature this
  computer does not have; `refused` a call it has, on a value or state it does not serve (a step on a disabled
  control). A provider's results use the same kinds the same way, with `vendor` as the only open one
  ([`provider.md`](provider.md#every-call-answers-a-result)).
- `code` follows from the kind:

  | Kind | Code |
  | --- | --- |
  | `invalid` | `-32602` (invalid params) |
  | `aborted` | `-32800` (request cancelled) |
  | `unsupported` for a method the computer does not have | `-32601` (method not found) |
  | a line that is not JSON | `-32700` (parse error), kind `invalid` |
  | a request line over the line limit | `-32600` (invalid request), kind `limit` |
  | every other kind | `-32000` (server error) |

## Limits

Each is in [`protocol.json`](protocol.json)'s `limits`:

| Limit | What it bounds |
| --- | --- |
| `maxLineBytes` | One line, a request or a reply, without its newline. A request over it gets an error reply and the connection goes on; a reply over it is replaced by an error of kind `limit`. |
| `maxOutputBytes` | Each of `exec.run`'s `stdout` and `stderr`. The rest is read and dropped, and `truncated` is true. |
| `maxChunkBytes` | One `files.read` or `tar.pull.read` (more is refused as `limit`), and one chunk of a screen image. In base64 it fits a line. |
| `maxListDepth`, `maxListEntries` | `files.list`'s depth and its entries. |
| `processRingBytes`, `processLogBytes`, `maxProcesses`, `processRetainedBytes` | What a computer keeps of its processes: the last bytes of each stream, read by offset; the first bytes in a log file; how many processes, running or ended; and the output of all of them together, past which the rings of processes that ended first are let go. |
| `maxReadWaitMs` | The longest a `process.read` waits for output. |
| `maxActions`, `maxBatchWaitMs`, `maxKeyRepeat` | One `input.actions` batch: its actions, the durations they add up to, and a key's repeat. |
| `launchWindowMs` | How long `apps.launch` waits for the app's window before it fails `timeout` ([below](#appslaunch)). |
| `maxUiNodes` | The nodes one `ui.observe` returns; past it, `truncated` is true. |
| `maxSteps` | The steps of one `ui.act`. |
| `maxExpectMs`, `defaultExpectMs` | How long a `ui.act`'s expect may wait, and waits when it names no `timeoutMs`. |
| `maxSettleMs` | The longest a `ui.act` waits for the window to settle after its steps. |
| `setHoldMs` | How long after the settle a `set` step's value is read again, to answer `verified` ([below](#the-rules-every-driver-keeps)). |
| `minImageEdge`, `maxImageEdge`, `defaultImageEdge` | A `ui.observe` image's longest edge in pixels: the range `maxEdge` may ask for, and what `image: true` gives. |

An `input.actions` batch is checked whole before any action runs: an action of a group the computer does not declare,
or a key not in the key table (`keys` in [`protocol.json`](protocol.json), or one printable character), refuses the
batch with nothing run. A batch that fails partway answers how many actions ran.

## apps.launch

`apps.launch` answers once the app it opened has a window, so a `ui.observe` or a screenshot sent right after it finds
that window. A launch that only asks the OS to open the app and answers at once races every caller. An app that shows
no window within `launchWindowMs` (10 s) fails the launch with kind `timeout`, in words naming the app. An app already
running with a window answers at once. The core case `apps.launch-window` observes the app right after its launch
answers.

## The ui group

`ui` sees one app's window as a flat list of named elements and acts on it with short lists of steps. Our drivers
serve it (Computerd on macOS, phoned on Android). A computer without them keeps `screen` and `input`, which stay raw
pixels and events. Four nouns carry it: a **computer**, an **app** on it, a **state** (one observation, with an id) and
a **step** (one action).

### ui.observe

```json
{"target":{"app":"com.apple.Notes"},"image":{"maxEdge":1024}}
```

- `target`: `app` (its id, as `apps.list` names it) and `window` (an id a result gave). Without it, the app in front
  and its main window. An app in the background is reached by its target.
- `full`: every node. Without it, the nodes a person acts on or reads (named, valued, actionable) and their parents.
- `image`: the window's image (feature `ui.image`), `true` or `{"maxEdge": n}` in pixels. It comes whole in the reply,
  at most `maxChunkBytes`.
- `since`: a state this connection observed before. The result's `diff` names the refs added, removed and changed.

The result:

```json
{"state":"s7","app":{"id":"com.apple.Notes","name":"Notes"},"window":{"id":"w1","title":"Notes","bounds":[120,80,900,640]},
 "nodes":[{"ref":"@e1","role":"button","name":"New Note","bounds":[12,8,28,28],"actions":["AXPress"]},
          {"ref":"@e2","role":"textbox","name":"Body","value":"","bounds":[240,60,640,560],"flags":["focused"]}],
 "truncated":false}
```

- `state`: this observation's id. It is the connection's own; a driver keeps the last few (32 in `UiEngine`).
- `window`: its `id`, `title` when it has one, `bounds`, and `role`: `"dialog"` for a sheet, an alert or a panel, absent
  for an ordinary window. An app with several windows is observed at its main one (the one in front) unless `target`
  names another.
- `window.bounds`: where the window sits, in screen points. A node's `bounds` are in **window points**, from the
  window's top left. A point in a step is in window points too. (`input.actions` stays in screen pixels.)
- A node's `bounds` lie inside its window. A driver clamps each edge that reaches past the window's to that edge, so a
  row half scrolled out of a list reports only the part a person sees and taps, and its centre is a point a step can
  use. An element wholly out of the window (flag `offscreen`, listed by a `full` observe) becomes a line, zero wide or
  zero high, on the edge it left by. `ui.observe-shape` fails a node whose bounds reach outside the window
  (`insideWindow` in `UiEngine`).
- A node: `ref` (`@e12`), `role` (one of `uiRoles`: ARIA's names, the same on every OS), `name`, `value` (what it
  holds, editable: a field's text, a slider's value; never for a `secure` field), `desc` (what else it says: a row's
  secondary text, a help tag), `id` (the app's own identifier, when it has one), `bounds`, `parent` (a ref before it),
  `flags` (of `uiFlags`) and `actions` (the platform's own names, such as `AXPress` or `ACTION_CLICK`).
- With `ui.tree` off (a Mac without the Accessibility grant), `nodes` is empty and `empty` says why; the window's image
  comes whether asked for or not, so a caller can still act at points from its state. With `ui.image` off as well,
  `ui.observe` is refused `denied` with both reasons. An act's `expect` reads the elements, so it is refused
  `unsupported` while the tree is off.

### ui.act

```json
{"target":{"app":"com.apple.Notes"},"steps":[{"press":"@e1"},{"type":"Ship it","into":"@e2"}],"expect":{"text":"Ship it"}}
```

- `steps`: at most `maxSteps`, run in order. Each is one of: `press` (the element's default action), `set` with `value`
  (a field's text, a slider's value, a switch's `"on"` or `"off"`), `perform` with `action`, `click` (a ref or a point;
  `button` and `count`), `type` (text, `into` a ref or where the focus is), `key` (a chord from the key table, `"super+s"`; its last key may be `+` itself, `"shift++"`),
  `nav` (`back`, `home`, `app_switch`; feature `ui.nav`), `scroll` (a ref or a point, `dx`, `dy` in points) and `drag`
  (points, with `ms`). There is no wait step: an act with no steps and an `expect` is a wait.
- `state`: the state the steps' points were read from. A step at a point needs it.
- `expect`: `text` somewhere in the window (in a name, value or desc, never a `secure` field's value), or on the element `ref`; with `gone: true`, until it is not. The computer
  polls it for `timeoutMs` (default `defaultExpectMs`, at most `maxExpectMs`).
- `expect.window`: `{"title"?, "role"?}`, at least one, and alone (no `text` or `ref`). The computer polls until the
  act's app shows a main window whose title holds `title` and whose role is `role` (`"window"` matches an ordinary
  one), and the act's `state` is then that window's. A dialog that opens a moment after a click is waited for this way.
  From its first look it reads the app's main window, never the window a `target` or `state` aimed the act at: an older
  window that matches while another is in front does not meet it.
  No such window in time is `unmet`, as any expect is, never `not_found`, even when the app has no window at all. An
  act that begins with no window keeps waiting for one of its own app: it never falls back to the app in front, and it
  never ends early because the app has no window left (`window: "closed"` is for a step that closed one). It
  reads only the window's title and role, so it runs with `ui.tree` off too. `ui.expect-window` checks it.
- `foreground`: the call allows the foreground route, which moves the user's pointer and focus. Default false.

The result:

```json
{"steps":[{"route":"semantic","verified":true},{"route":"semantic","verified":true}],"state":"s8","changed":true,"expect":"met"}
```

- Each step that ran answers its `route` and whether a readback `verified` it. The routes, best first: `semantic` (an
  accessibility action), `page` (a page's own script, feature `ui.page`), `background` (input posted to the app, feature
  `ui.background`), `foreground` (real input, feature `ui.foreground`, only with `foreground: true`).
- `verified: true` means a readback saw the step's effect, never less. Input posted to an app may not reach a view
  that takes real input only, and the driver cannot always tell: such a step answers `verified: false`. A step the
  driver knows needs the foreground route, in a call without `foreground: true`, is refused `denied`.
- A step that may not run answers `{"error": {"kind", "message"}}`, and it is the last result: the steps after it do
  not run. Its kinds: `stale`, `invalid`, `denied`, `unsupported`, `not_found`, `timeout`, `limit`, `refused`,
  `aborted`. A person who takes the computer back stops the act with `aborted` and nothing sent: before a step would
  take the foreground route, and before every step once one took it, the person's keyboard or mouse used since the
  act began, or the pointer moved from where the act last left it, ends the act there, as it ends an `input.actions`
  batch. A step on a disabled control by its ref is refused `refused`: a field's text never goes to whatever has the focus.
  For the same reason, a `type` into a ref that is not a text field is refused `refused` with nothing sent, and a
  driver that focuses a field before typing (a tap) checks the field took the focus, else refuses `refused` with
  nothing typed.
- `state` is the window after the act settled, `changed` whether it differs from before the steps, and `expect` is
  `met` or `unmet` (absent without an expect, or when a step was refused).
- `window: "closed"` replaces `state` when the act's app has no window left: a step closed its last one (a Close
  button, `super+w`), or a window wait ended with none. The steps that ran keep their results, a step after the one
  that closed it is refused `stale`, and `changed` is true. The app may still be running; `apps.launch` opens its
  window again.

### The rules every driver keeps

- **A ref stays good as long as its element exists.** The driver keeps the element behind each ref, so a ref from an
  earlier state still works after other steps ran. A step on a ref whose element is gone is refused `stale`. A ref this
  connection was never given refuses the whole act as `invalid`.
- **A point is bound to its state.** A step at a point is refused `stale` when its state is no longer held, the window
  is another one, the window changed size, or what is under the point changed. Where no element is under the point
  (always so with `ui.tree` off), any change to what the window shows makes it stale. A point outside the window is
  `invalid`. A window that only moved keeps its points good, because they are window points. Every point a step
  touches is held to this, each point of a drag's path as much as its first.
- **The driver waits, never the model.** Every act settles before it answers: the window looks the same twice, a short
  quiet apart, or `maxSettleMs` passed. An expect is polled on the computer, and an act's `state` is the window once it
  settles after the expect, never a frame of a transition. Every verdict of an act reads that one final view: a set's
  hold, the expect's `met`, and the `state` it answers. A poll's look only says when to read the final view again.
- **A settle reads the tree.** "Looks the same" compares the window's id, bounds and the nodes on it (each node's role,
  name, value, flags and bounds). A node wholly outside the window is not seen, so it counts neither for a settle nor as
  a step's effect: an app may rebuild its rows scrolled out of view each time its tree is read (System Settings'
  sidebar), which would wait out `maxSettleMs` on every act. The window's image counts only when the window has no
  nodes (`ui.tree` off, or an app that exposes none). A blinking caret, a spinner's frame or a playing video changes the image every look, so a settle on
  the image would wait out `maxSettleMs` on every act; a transition moves the nodes, so a settle on the tree still
  waits for it. `ui.settle-tree` times acts on a focused field.
- **A set holds.** A `set` step answers `verified: true` only when its value still holds in the act's final view: read
  no sooner than `setHoldMs` (500 ms) after the act settled, and after the expect's last settle, so a value taken back
  while the expect waits is not verified. An app that takes the value back (a field that rejects it, a
  switch a policy turns back off) answers `verified: false`, though the set itself ran. The hold is waited out even
  when a later step closed the last window: a value that cannot be read then is `verified: false`, never true.
  `ui.set-holds` sets the
  fixture's Code field, which takes its value back.
- **An act follows its app's windows.** When a step closes the window the act is aimed at, the act follows the app's
  next main window, as after a `nav`: the steps after it, the settle, the expect and the answered `state` are that
  window's. When the app has no window left, the act answers `window: "closed"` with no `state` (above).
  `ui.window-follow` and `ui.window-closed` close the fixture's windows.
- **An act follows the app a step leaves for.** A `state` or `target` aims the act at its app's window; an act with
  neither is aimed at the app in front when it begins, so a step that opens another app never lets a later step reach
  it. After a `nav`
  step, the act follows the window in front: the steps after it, the settle, the expect and the answered `state` are
  that window's. When any other step (a key, a tap that opens another app) takes the aimed window away, the step after
  it is refused `stale` and runs nothing, and the act settles on the window in front. Either way the steps that ran
  keep their results.
- **Nothing silent.** A feature that is off is refused with its reason, in words. A step a route cannot reach is
  refused, never sent to the wrong place.
- **One at a time.** A connection's ui calls run in order; one act's steps never interleave with another's.

`UiEngine` in `packages/computer/src/ui-engine.ts` implements these rules over a small source interface (look, image,
run one step). The Android phone over adb and the fake driver use it; a native driver keeps the same rules in its own
code, and the conformance suite's `ui` cases check them over the wire (see [`kinds.md`](kinds.md#the-ui-fixture)).
