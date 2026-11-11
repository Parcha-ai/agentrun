# Kinds, groups and levels

## Kinds

A computer's **kind** is the shape its tools take. A provider declares it in `capabilities().kind`, and each
computer's `hello` repeats it. Each kind allows these operating systems and daemon modes, and no other pair:

| Kind | os | daemon |
| --- | --- | --- |
| `linux` | `linux` | `pid1`, `child` |
| `desktop` | `linux`, `windows`, `macos` | `pid1`, `child`, `none` |
| `android` | `android` | `none` |
| `ios` | `ios` | `none` |
| `browser` | `linux` | `none` |

The daemon modes are in [`stdio.md`](stdio.md#how-the-daemon-gets-in-the-daemon-modes).

## Groups

A **group** is something a computer offers. A provider declares its groups in `capabilities().groups`, and each
computer's `hello` repeats them. A group is offered only when declared there, and the computer answers its methods (see
[`wire.md`](wire.md#methods)).

| Group | What it offers |
| --- | --- |
| `exec` | Run a program to its end, with its output. |
| `files` | Read, write, stat, list, make, move and remove files; tar archives in and out. |
| `processes` | Programs that outlive the call: start, read, write, signal, resize, list and wait. |
| `screen` | A screenshot, and a live view (`screen.watch`). |
| `input.pointer` | Move, click, drag and scroll a pointer. |
| `input.keys` | Type text and press keys. |
| `input.touch` | Tap, long-press, swipe and pinch. |
| `apps` | List the installed apps, which is in front, launch one and end one. |
| `apps.install` | Install an app from a file in the computer. |
| `apps.ui_tree` | The screen's structure: what can be tapped or typed into, with bounds. |
| `cdp` | A browser's Chrome DevTools Protocol target (the provider's: `ComputerConnection.cdp`). |
| `stream` | A live view by URL (the provider's: `provider.stream()`). |
| `downloads` | The files a browser saved (the provider's). |

`cdp`, `stream` and `downloads` are the provider's, not the daemon's: a daemon's `hello` never lists them. The full
list, in order, is `groups` in [`protocol.json`](protocol.json).

## Setting kinds: what an agent is given

An owner gives an agent a computer by a **setting kind**. A provider serves a setting kind when its machine kind is one
of the setting kind's, and it declares every required group. That is computed from its capabilities, never written by
hand.

| Setting kind | Machine kinds | Required groups | Optional groups |
| --- | --- | --- | --- |
| `none` | (no computer) | | |
| `sandbox` | `linux` | `exec`, `files`, `processes` | |
| `desktop` | `desktop` | `screen`, `input.pointer`, `input.keys` | `exec`, `files`, `processes`, `apps`, `stream` |
| `phone` | `android`, `ios` | `screen`, `input.touch`, `apps` | `input.keys`, `apps.install`, `apps.ui_tree`, `stream` |
| `browser` | `browser` | `cdp` | `stream`, `downloads` |

## Levels: Core and Full

The conformance suite's levels follow the Kubernetes agent-sandbox levels:

- **Core** is what a computer of its kind must do. A Core case that fails, or that skips for anything but an optional
  group the computer does not declare, fails Core. A run leaves no computer behind, or Core fails.
- **Full** is an optional capability, tested only where it is declared: a network that is open or an allowlist, the
  janitor, takeover by claim, root or another user, extend, a mounted disk.

What Core requires depends on the kind and the daemon mode:

| Kind | Core requires |
| --- | --- |
| any, with computerd (`pid1` or `child`) | `exec`, `files` and `processes`, and network `none`, read from inside: nothing answers |
| any, with daemon `child` | the ports of the vendor's own agent declared (`capabilities().vendorAgentPorts`), and none of them reachable from the computer's programs |
| `desktop` | `screen`, `input.pointer`, `input.keys` |
| `android`, `ios` | `screen`, `input.touch` |
| `browser` | `cdp` |

Every kind's Core also covers:
- `hello` and `ping`, and an unknown method refused in words;
- the provider's descriptor, `capabilities()` and `hello` agreeing, at this protocol version;
- where the provider takes a key or token, none of it in any error the provider answers;
- create, attach (with the spec read back), list, network read-back and release;
- a daemon of another version never handed out.

`screen` brings the live view (`screen.watch`) into Core wherever it is declared.

A run with `--kind <setting kind>` gives a pass or fail verdict for that setting kind: the provider serves it, and
every case of each of its required groups passes.
