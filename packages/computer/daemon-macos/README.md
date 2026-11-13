# Computerd for macOS

Computerd.app lets an agent use a Mac's apps through the computer protocol (`spec/computer`, version 0.2). It runs in
the logged-in desktop as a LaunchAgent and holds the Mac's grants itself, so nothing else needs them: not Terminal, not
an SSH session, not the agent's host.

It speaks the protocol three ways:

- **Its socket**, `~/Library/Application Support/Computerd/computerd.sock`: mode 0600, and each client's code signature
  is checked, so only Computerd's own binaries connect.
- **The `computerd` command** (`Computerd.app/Contents/Helpers/computerd`): relays stdin and stdout to the socket. This
  is the stdio binding, for SSH or a local harness.
- **The attach binding**: it dials the server it is paired with (`wss://<server>/v2/computers/attach`), so the Mac needs
  no open port and works behind any NAT.

## What it does

| Method | On macOS |
| --- | --- |
| `hello` | The screen in points and its scale, the Mac's model and macOS build, and each feature on or off with the reason (a missing grant, a missing private symbol). |
| `exec.run`, `files.*`, `tar.*` | As the logged-in user, as the Linux daemon does. The paired server gets them only by your grant (`"server"` in `policy.json`, below). |
| `screen.shot`, `screen.watch` | ScreenCaptureKit; needs Screen Recording (feature `screen.capture`). The paired server gets them only by your grant. |
| `input.actions` | The Mac's own keyboard and mouse (groups `input.pointer` and `input.keys`, which with `screen` make it a desktop): move, down, up, click, drag, scroll in clicks or pixels, key, hold, type and wait, in screenshot pixels, posted as a person's hands would post them, to the app in front. It needs Post Event, as the foreground route does. With an owner's list of apps, the app in front must be on it. A person using the keyboard or the mouse during a batch stops it before its next action (`aborted`, by the take-over rule a `ui.act` keeps), and what it held is released; the batch's own events never count. No touch actions. |
| `apps.list`, `apps.launch`, `apps.terminate` | NSWorkspace. The list is every app in the Applications folders and every app running. `background: true` opens the app without bringing it forward, and sends it back if it comes forward on its own. |
| `ui.observe` | The window's accessibility tree, batched, at most a second per call to the app, capped at 5,000 nodes; compact or full; a diff since a state; the window's own image (it shows even when covered). Without Accessibility (`ui.tree` off) it answers the window's image with no nodes and says why, and steps at the image's points still run. |
| `ui.act` | Each step on the first route that can do it: **semantic** (AXPress, a value set and read back, a menu item for `super+s`; a document's text area takes typed keys first, since an inserted text never marks the document edited), then **background** (input posted to the app's window through SkyLight, without moving the pointer or raising the window), then **foreground** (the real keyboard and mouse) only when the call says `foreground: true`. Each step's result names its route and whether its effect was verified. A person using the keyboard or the mouse stops an act before its foreground step, and before every step after one (`aborted`, nothing sent). |

`ui.page` (web pages through the browser's own protocol) and `ui.nav` (macOS has no system back or home) are off, with
the reason in `hello`.

## Install on a Mac

macOS 14 or later.

1. **Get the app.** From a release, or build it on the Mac (Xcode 16 or later):

   ```sh
   cd packages/computer/daemon-macos
   scripts/bundle.sh            # writes build/Computerd.app, signed ad hoc
   cp -R build/Computerd.app /Applications/
   ```

   `COMPUTERD_SIGN_IDENTITY="Developer ID Application: <name> (<team>)" scripts/bundle.sh` signs it for distribution.
   An ad-hoc build is granted anew after each rebuild; a Developer ID build keeps its grants across updates. A Mac that
   builds its own Computerd can sign with a local self-signed identity instead.

2. **Open it.** Double-click Computerd in Applications. It writes its LaunchAgent to
   `~/Library/LaunchAgents/ai.parcha.computerd.plist` and loads it with `launchctl`, which starts it now and at every
   login. macOS lists it under System Settings > General > Login Items & Extensions. The window's **Remove** unloads
   it and deletes the plist.

3. **Grant it.** The grants window opens the System Settings pane of the first grant still missing beside it. Drag the
   window's Computerd tile into the pane's list; its rows tick as the grants come in, the next pane opens, and the
   window closes once all three are in:
   - **Accessibility**: to read windows and press their buttons.
   - **Post Event** (from the same Accessibility list): to click and type into a window.
   - **Screen Recording** (Screen & System Audio Recording): to see windows and the screen.

   In the window after it, click **Raise it now** for the screen capture alert and answer it, so it never appears in
   the middle of a task.

4. **Check it.**

   ```sh
   /Applications/Computerd.app/Contents/Helpers/computerd hello
   ```

   Every feature it cannot offer says why.

## Pair it with a server

1. Ask the server for a pairing code, in its console or with `POST /v2/computers/pairings`. A code reads like
   `K7PD-W3QX` and is good once, for 10 minutes. (The server's pairing routes and console page are listed in
   `spec/computer/attach.md` under "What serve needs".)
2. Enter the server's address and the code in Computerd's window and click **Pair**, or run:

   ```sh
   /Applications/Computerd.app/Contents/Helpers/computerd pair https://<server> K7PD-W3QX "My Mac"
   ```

Computerd trades the code for its computer id and a token, keeps the token in your keychain, and dials the server. The
console then lists the Mac as online. A run that names it gets it, one run at a time. The command hands the server and
code to the running app, which pairs in your login session, so it works over SSH too. If the server paired the Mac but
the token could not be kept, Computerd says so: remove the Mac in the console's Computers page and pair again.

- **Unpair:** `computerd unpair`, and remove the computer in the console (which revokes its token).
- **Offline:** Computerd dials again after any drop, waiting 1 s, then doubling to a minute. It stops only when the server
  says its token is revoked or unknown, or it paired as another kind of machine (pair again), or it speaks another
  protocol version (update Computerd).
- **Which apps, and what the server gets:** `~/Library/Application Support/Computerd/policy.json` is yours to write.
  `"apps"` lets connections touch only the apps whose bundle ids it lists. `"server"` is what the server this Mac is
  paired with may use besides apps: `"exec"` (run programs), `"files"` (read and write files, tar archives too) and
  `"screen"` (capture the whole screen, whichever apps are on it). Without `"server"` it gets none of them: its `hello`
  offers no `exec` or `files` group and says `screen.capture` is off, and each such call is refused, saying who can
  switch it on and where. For example `{"apps": ["com.apple.TextEdit"], "server": ["screen"]}`. `"exec"` or `"files"`
  gives the server the run of your account, not a part of it: with either it can change what your login starts, or this
  file itself, and so take the rest. Grant them only to a server you would give a shell. `"screen"` alone gives no more
  than the screen. A file that does not
  parse (a value it does not know included) allows no app and grants the server nothing until it is fixed. Computerd
  reads the file at each connection, so a change applies from the next one.

## Use it over SSH

```sh
ssh mac /Applications/Computerd.app/Contents/Helpers/computerd stdio
```

The command needs no grant of its own: the app does the work, in the desktop session, under its own grants. A stdio
connection offers exec, files and the screen without `"server"` in `policy.json`, since only this user's own Computerd
binaries open the app's socket (mode 0600, each client's code signature checked) and whoever runs them, over SSH or in a
terminal, already has a shell here. The app tells the two apart by where the connection came from: the socket, or the
socket it dialed to the paired server. `"apps"` holds on both.

## Logs

`~/Library/Logs/Computerd.log`. Restart the agent with `launchctl kickstart -k gui/$(id -u)/ai.parcha.computerd`.

## Build and test

```sh
swift build --build-tests && swift test     # on a Mac; the core (ComputerdKit) also builds and tests on Linux
```

- **ComputerdKit**: the protocol's types, the wire, refs and states, settle, expect and the route ladder. No OS calls:
  every one sits behind the protocols in `Sources/ComputerdKit/UI/Platform.swift`, so the logic is tested with fakes.
  `SchemaTests` holds the Swift types to `spec/computer/schema/methods.schema.json`.
- **ComputerdMac**: those protocols on macOS (accessibility, ScreenCaptureKit, NSWorkspace, SkyLight input, the
  keychain, the socket's peer check, the attach client).
- **ComputerdApp**: the app. **ComputerdCLI**: the `computerd` command.
- **UIFixture**: the ui conformance cases' fixture app (`ai.agentrun.uifixture`, per
  `packages/computer/src/conformance/ui-fixture.ts`). `COMPUTERD_UI_FIXTURE=1 scripts/bundle.sh` writes
  `build/UIFixture.app`; test-only.

CI (`.github/workflows/computer-macos.yml`) builds and tests on `macos-26`, bundles the app, seeds the runner's grants,
starts the app under launchd in the runner's desktop, and checks the socket's peer check, and runs the protocol's health, ui and input conformance cases
(`scripts/ui-conformance.mjs`) through `computerd`, with the results in the job summary.

See NOTICE for the projects whose findings Computerd uses.
