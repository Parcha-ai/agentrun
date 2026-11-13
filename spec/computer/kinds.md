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

The daemon modes are in [`stdio.md`](stdio.md#how-the-daemon-gets-in-the-daemon-modes). A mode says whether
`computerd init` runs in the computer, keeping init's promises about programs, and nothing about who answers the wire:
an attached Mac's Computerd and a phone's own agent are `none`. An attached Mac offers `exec`, `files` and its screen
only when its owner's grant says so (`"server"` in its `policy.json`): with the grant it declares `exec` and `files` as
groups, just not as Core; without it it declares neither, and its `screen.capture` feature is off, saying who can switch
it on and where. It still declares the `screen` group, which a desktop needs to be given to an agent, and refuses each
`exec`, `files`, `tar` and `screen` call it was not granted, whatever its `hello` said.

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
| `ui` | One app's window as named elements with refs (`ui.observe`), and steps on them that settle and say how they ran (`ui.act`). Its features are in `hello.features`. |
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
| `desktop` | `desktop` | `screen`, `input.pointer`, `input.keys` | `exec`, `files`, `processes`, `apps`, `ui`, `stream` |
| `phone` | `android`, `ios` | `screen`, `input.touch`, `apps` | `input.keys`, `apps.install`, `ui`, `stream` |
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

`screen` brings the live view (`screen.watch`) into Core wherever it is declared. `ui` brings `ui.hello` (its
`hello.screen` and `hello.features`) and `ui.observe-shape` into Core wherever it is declared.

## The ui fixture

The `ui` group's rules are checked on a small app whose behaviour the suite knows, so a case checks what a driver did
with no model: `ai.agentrun.uifixture` (`packages/computer/src/conformance/ui-fixture.ts`), a window of 320 by 320
points, which fits a small phone in portrait. Its home window has a
"Name" field, a "Wi-Fi" switch, "Save" (which shows "Saved" a moment after its press, so only an expect sees it), "Next"
(which opens a second page after a moment and a transition), a "Canvas" that only foreground input reaches, whose
value is the number of clicks that reached it, a "Code" field that takes back any value set into it a moment later,
"New window" (which opens a second window titled "Another window" after a moment) and "Close" (which closes the
window it is in; the second window has one too). The second page has "Back". Closing the last window leaves the app
running with none, and `apps.launch` opens its main window again. A fixture that cannot open a second window (one
window per app, as on a phone) leaves out "New window", and the window cases skip in words.

A driver's conformance image installs the fixture, built for its OS from that description. Its cases are Full: a
computer without it skips them in words. Where it is installed, the Core cases `apps.launch-terminate`,
`apps.launch-window` and `ui.observe-shape` use it too, so a computer that offers no exec or files (an attached Mac without its owner's grant, a phone) still runs them;
without it they use a phone's Settings app, or the input fixture written with files. They check observe's shape on a known window, refs that survive a change and
go `stale` when their element leaves, a point refused `stale` once its window changed, an expect met and one unmet, the
route each step reports (in every case, never a route whose feature is off, nor foreground on a call that did not
allow it), a click never answered verified unless it landed (on the canvas without `foreground: true`,
a driver may refuse it `denied` or post it unverified; with it, the click lands and is verified by its count), a
settle on the tree while a caret blinks, a set the app takes back answered unverified, a window expect, an act whose
window closed (with another to follow, and with none left), and each feature: on, it does what it says; off, it is
refused with its own sentence.

`@parcha/agentrun-computer/fake-ui-driver` runs the fixture with no Mac and no phone, over the wire: in process
(`fakeUiConnection`, `fakeUiProvider`) or on stdin and stdout. Drivers and surfaces test against it.

A run with `--kind <setting kind>` gives a pass or fail verdict for that setting kind: the provider serves it, and
every case of each of its required groups passes.
