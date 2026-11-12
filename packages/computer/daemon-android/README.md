# phoned, the phone's driver

phoned answers the computer protocol (`spec/computer/`, version 0.2) on an Android phone. It is one dex jar,
`dist/phoned.jar`, which the phone harness provider (`src/phone-harness.ts`) pushes to the phone and starts as the shell
user:

```sh
adb push dist/phoned.jar /data/local/tmp/phoned.jar
adb exec-out 'CLASSPATH=/data/local/tmp/phoned.jar app_process / ai.agentrun.phoned.android.Main 2>/data/local/tmp/phoned.log'
```

Then it reads JSON-RPC lines on stdin and writes replies on stdout (`spec/computer/stdio.md`). Closing its stdin ends it,
and the requests still running are cancelled. This is scrcpy's way in: `app_process` runs a Java main as the shell user,
which may inject input, read the screen and connect UiAutomation without an installed app. Parts of the Android layer
are adapted from scrcpy; `NOTICE-scrcpy.md` lists each file.

## Build

Plain Java 17, no Gradle. `npm run build:phoned` compiles against the pinned platform's own `java.base` and
`android.jar`, so a `java.*` call a phone lacks fails at build time, then runs d8 with `--min-api 30`: phoned runs on
Android 11 and later, and a call newer than that needs a `Build.VERSION.SDK_INT` check. The pin is `ANDROID` in
`scripts/android-sdk.mjs`, shared with the ui fixture's build: `platforms;android-35` and `build-tools;35.0.0`, which
GitHub's ubuntu-24.04 and macos-15 runner images ship. It needs:

- a JDK 17 or newer: `JAVA_HOME_17_X64`, `JAVA_HOME_17_arm64` (the runner images'), `JAVA_HOME`, else `PATH`;
- an Android SDK (`ANDROID_HOME` or `ANDROID_SDK_ROOT`) with that platform and those build tools.

When one is missing the build stops with one sentence naming it and where it looked.

The jar is reproducible for a given pin: the same sources, version and build tools give the same bytes. Another
build-tools version's d8 writes other bytes, so moving the pin changes the jar's sha256 (a frozen live run pins it).
Its version is this package's, so the provider refuses a phone whose phoned reports another (`drift.version`).

`npm run test:phoned` runs the JVM tests (`src/test`), with the host JDK alone, and then the TypeScript client against
phoned's real core over a scripted phone (`src/fake`, `test/phoned/`).

## Layout

- `src/core`: the protocol and every method's rules, pure Java with no Android class. The phone is behind the
  interfaces in `device/` (`Device`: its facts and display, accessibility, input, screen and apps).
  - `Wire`: JSON-RPC lines, one thread per request, `$/cancelRequest`, and the 1 MiB line limit.
  - `Phoned`: hello and the method table. `UiDriver` and `Outline`: `ui.observe` and `ui.act`. `Actions`:
    `input.actions`. `Shots`: `screen.shot`, `screen.read`, `screen.watch`. `Exec`: `exec.run`. `Settle`: when a
    screen is still.
- `src/android`: the phone itself through hidden APIs (`Hidden`, `Workarounds`, `FakeContext`): UiAutomation (`Ax`,
  `Node`), InputManager (`PhoneInput`), the clipboard, the screen (`PhoneScreen`), and the activity and package
  managers (`PhoneApps`). `Main` is the entry point.
- `src/fake`: a scripted phone for the tests (a launcher; Settings with its scrolling list, search field and Internet
  page; Chrome; the ui fixture), and `FakeMain`, phoned's core on stdio over it, which the TypeScript tests, the
  conformance suite (`test/phoned/phone-conformance.test.mjs`) and the live probe's dry run start in a phone's place.

## What it answers

- `hello`: protocol 0.2, the package version, `os` and `kind` `android`, `osVersion` (`"15 (API 35)"`), `arch` (Go's
  names: `arm64`, `amd64`), `device` (`maker`, `model`), the groups `exec`, `screen`, `input.keys`, `input.touch`,
  `apps` and `ui`, `screen` in points with its scale, and `features`, each on or off with the reason.
- `ui.observe`: the window in front (or the app or window named) straight from UiAutomation, connected with
  `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` so a screen reader the phone runs keeps running. A clickable row with no
  name of its own is named from its children's texts, the rest of them its `desc`. Zero-size elements are dropped. A
  ref stays the same while its element lives. An element's `id` is its resource id without the package
  (`recycler_view`), its `value` a text field's text or else the app's state description (a count, "On"). Bounds are
  in window points, cut to the window: one scrolled out (`offscreen`, in a full observe) is a line on the edge it
  left by.
- `ui.act`: steps by ref through accessibility actions (`semantic`), or through injected input (`foreground`): a
  point, a key, a drag, or an element without the action (a canvas). Injected input reaches the focused display
  directly, so phoned reports it as `foreground`, and a call without `foreground: true` gets it refused `denied`. A
  step is `verified` only when the window, read back, differs from before it: an event or a frame alone verifies
  nothing. The `expect` is checked after the last step.
- `input.actions`: taps, long presses, swipes and paths, a two-finger pinch, buttons (back, home, app switch), keys and
  combos, holds, and text: typed by the key map when every character has a key, else pasted through the clipboard,
  which is put back after.
- `screen.shot`, `screen.read`, `screen.watch`: the display read on the phone, scaled there to `maxWidth`.
- `apps.list`, `apps.launch` (an app id, a deep link, or both), `apps.terminate`.
- `exec.run`: a program as the shell user, with a minimal environment, killed with its whole process tree at its
  timeout or cancel.

A window marked secure (`FLAG_SECURE`) is refused `denied` with the reason, never sent as a black image. files,
processes and tar are not phoned's: a phone has no files group.
