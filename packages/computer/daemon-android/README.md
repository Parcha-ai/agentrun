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

Plain Java 17, no Gradle. `npm run build:phoned` compiles against Android 11's (API 30) own `java.base` and
`android.jar`, so a call an older phone lacks fails at build time, then runs d8. It needs:

- a JDK 17 or newer (`JAVA_HOME`, else `PATH`);
- an Android SDK (`ANDROID_HOME` or `ANDROID_SDK_ROOT`) with `platforms;android-30` and `build-tools;35.0.0`.

The jar is reproducible: the same sources and version give the same bytes. Its version is this package's, so the
provider refuses a phone whose phoned reports another (`drift.version`).

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
- `src/fake`: a scripted phone (Settings and its Internet page) for the tests, and `FakeMain`, phoned's core on stdio
  over it, which the TypeScript tests and the live probe's dry run start in a phone's place.

## What it answers

- `hello`: protocol 0.2, the package version, `os` and `kind` `android`, `osVersion` (`"15 (API 35)"`), `arch` (Go's
  names: `arm64`, `amd64`), `device` (`maker`, `model`), the groups `exec`, `screen`, `input.keys`, `input.touch`,
  `apps` and `ui`, `screen` in points with its scale, and `features`, each on or off with the reason.
- `ui.observe`: the window in front (or the app or window named) straight from UiAutomation, connected with
  `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` so a screen reader the phone runs keeps running. A clickable row with no
  name of its own is named from its children's texts, the rest of them its `desc`. Zero-size elements are dropped. A
  ref stays the same while its element lives. Bounds are in window points.
- `ui.act`: steps by ref through accessibility actions (`semantic`), or at a point through injected input
  (`foreground`). Each step settles (accessibility events quiet for 150 ms, and a new frame when one is due), is read
  back, and the `expect` is checked after the last.
- `input.actions`: taps, long presses, swipes and paths, a two-finger pinch, buttons (back, home, app switch), keys and
  combos, holds, and text: typed by the key map when every character has a key, else pasted through the clipboard,
  which is put back after.
- `screen.shot`, `screen.read`, `screen.watch`: the display read on the phone, scaled there to `maxWidth`.
- `apps.list`, `apps.launch` (an app id, a deep link, or both), `apps.terminate`.
- `exec.run`: a program as the shell user, with a minimal environment, killed with its whole process tree at its
  timeout or cancel.

A window marked secure (`FLAG_SECURE`) is refused `denied` with the reason, never sent as a black image. files,
processes and tar are not phoned's: a phone has no files group.
