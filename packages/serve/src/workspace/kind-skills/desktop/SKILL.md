---
name: desktop-computer
description: Use a desktop computer (a Mac, or a Linux desktop) through computer_observe, computer_act, computer_screenshot and computer_script. It covers reading an app's elements, acting on them by ref, running known steps as one script, checking what happened, recovering, and reading the computer's refusals. Use when a run has a desktop and the task needs its apps or its windows.
---

# Using a desktop

The run has a desktop, rented while the run lives. You read an app's window as a list of its elements and act on
them by their refs, the way an accessibility tool does. Where the desktop can't list elements (no `ui` group), you see
it through screenshots and act at their pixels. The tools say which one you have.

## The tools

**`computer_observe` `{app?, image?, full?}`** shows an app's window (the one in front when you name none) as compact
lines, one per element:

```
state s3 · com.apple.Notes "Notes" · window "Groceries" 900×700 pt
@e1 window "Groceries"
  @e4 textbox "Title" = "Groceries" [focused]
  @e7 button "Save"
```

Each line is a ref (`@e7`), a role, a name, a value after `=`, what else the element says in parentheses (a help tag)
and flags in brackets. A child is indented under its parent. When an app draws its own window, the computer can't
list its elements: the outline says so, the window's picture comes with it, and you act at points in that picture. The head line names the **state** (`s3`). `image: true` adds the window's picture, which you need only for
what elements can't tell you: layout, colours, images. `full: true` lists every element, not only the named or
actionable ones.

**`computer_act` `{app?, steps, state?, expect?, observe?}`** runs steps in order:

| Step | What it does |
|---|---|
| `{press: "@e7"}` | The element's own action (a button's press, a menu item's pick). The surest step. |
| `{set: "@e4", value: "Milk"}` | Sets a field's text, a slider's value, a switch's `"on"` or `"off"`. |
| `{click: "@e7"}` or `{click: [x, y]}` | A click on the element, or at a point; `button: "right"`, `count: 2`. |
| `{type: "text", into?: "@e4"}` | Types, into the element when named, else where the focus is. |
| `{key: "super+s"}` | A key or a chord: names or one character, joined by `+` (`enter`, `ctrl+shift+t`). |
| `{scroll: "@e9", dy: 300}` | Scrolls by points: `dy` above 0 shows what is below. |
| `{drag: [[x1, y1], [x2, y2]]}` | Presses at the first point, lets go at the last. |
| `{perform: "@e7", action: "AXShowMenu"}` | One of the element's own platform actions. |

Each step answers its **route** (`semantic`: through the element; `page`: through the page; `background`: an event to
the app; `foreground`: the real pointer and keys) and whether a readback **verified** it. The answer ends with whether
the window changed and its new state. `expect: {text: "Saved"}` waits after the steps until that text shows (`gone:
true`: until it is gone); no steps and an expect is a wait. `observe: true` adds the new outline: one call instead of
two. The first refused step stops the rest.

Prefer refs. A step at a point (`[x, y]`, in the window's points) is read against a state, the last one you observed
unless you name another, and is refused as **stale** once the window moved or redrew under it: observe again and use
the new state.

**`computer_screenshot` `{region?}`** is the whole screen, or `region: [x, y, w, h]` of it, in screen pixels.

**`computer_script` `{code}`** runs JavaScript in an isolate whose only binding is `computer`. Its tool description
gives the `computer` object's types for this desktop. The body is an async function: `await` the calls and `return`
what you need; `text(...)` and `image(...)` show words and pictures beside the value.

```js
const notes = computer.app("com.apple.Notes");
await notes.observe();
const title = notes.find({ role: "textbox", text: "Title" })[0];
await notes.set(title.ref, "Groceries");
const saved = await notes.key("super+s", { expect: { text: "Saved" } });
return { saved: saved.expect, state: saved.state };
```

**Your harness's own code mode.** pi's `codemode` binds `computer` as computer_script does. Codex's `exec` does not:
there, call the tools, each answering its value as JSON text, or call `tools.computer_script` with the code above.

```js
const notes = JSON.parse(await tools.computer_observe({ app: "com.apple.Notes" }));
const title = notes.elements.find((node) => node.role === "textbox" && node.name === "Title");
```

**The screen itself.** Prefer an app's steps. A script's `computer.input.act([...])` is the screen-level way out, at
screenshot pixels (`computer.screen.shot()`), for what one app's window can't reach: a drag from one app to another (a
file from Finder into a Mail message), or anything outside every window.

**Only the tools you were given.** An agent's computer setting may leave some out: a code-only agent has its script
tool and no `computer_observe`, `computer_act` or `computer_screenshot`; a tools-only agent has those and no script
tool; an agent whose exec is off has no `computer.shell`, no `computer.processes` and no bash, so it opens apps with
`computer.apps` and works through the screen. Use what your tool list shows.

## How to work: observe, then act by ref, then check

1. **Observe** the app first. Find your target by its name and role, and note its ref.
2. **Act** by ref. Several steps you are sure of go in one `computer_act`: set a field, press a button. End the call
   where you need to see the result.
3. **Check** what the answer says: each step's route and verified, `changed`, and the expect's `met` or `unmet`. A
   step that ran is not proof the app did what you meant. When the answer doesn't settle it, observe again.
4. **Recover.** A refused step says why. `stale`: observe again, then act on the new refs or state. Nothing changed:
   a dialog may be in front, or the element may be disabled (`[disabled]`). Try once more another way (`press`
   instead of `click`, the keyboard instead of the pointer, a menu instead of a button), then change approach.

## When to write a script

A script is one call where tools would be many. Use one when:

- **You know the steps.** A form you have seen, a menu path you know, a sequence you have done once: run it as one
  script with an `expect` at the end, instead of one act per step.
- **You need a few facts out of a big window.** Observe and `find()` inside the script, and return only what the next
  decision needs: a ref, a value, a count, three rows. Never return whole observations: their elements are long, and
  you pay for every line you read. `find({ role, text, id })`: a role is the same name on every OS, a text matches
  the name, the value or what the parentheses say, and an id is the app's own for the element.
- **You loop.** Scroll a list until a row shows, or read each row of a table.

Don't script steps you have not seen yet. When you are unsure what is on the screen, observe before you act, by tool
or inside the script, and decide from what it shows.

## Without the ui group (a Linux desktop)

The desktop lists no elements. `computer_observe` answers a screenshot of the whole screen, and `computer_act`'s steps
are raw input at its pixels: `click`, `type`, `key`, `scroll` and `drag` at points, with no refs, no states and no
expect. `press`, `set` and `perform` are refused. Take the points from the latest screenshot, aim at the middle of a
target, and take another screenshot to see what your steps did. Click a field before typing into it.

Open an app from a script with `computer.processes.start("mousepad")`: it opens on the desktop's screen and stays
open. `computer.shell.run` ends everything its command started when it returns, so an app it starts closes at once.
`shell.run("command -v firefox gedit xterm")` shows which apps the desktop has.

## Habits that work

- **The keyboard is exact.** `super+a` (Mac) or `ctrl+a` selects all, `escape` closes a menu or a dialog, `enter`
  confirms. A chord doesn't depend on where things are drawn.
- **Dialogs first.** A sheet, an alert or a permission prompt blocks the window under it: answer it, then go on.
- **Wait by expecting.** Put an `expect` on the step that starts something slow, rather than observing in a loop.
- **The right app.** Name the app (`app: "com.apple.Notes"`) when more than one is open. In a script,
  `computer.apps.open(id)` opens one, and `computer.app(id)` binds it.

## When a tool answers an error

Errors come in words, and they say what was wrong. Read them, act on what they say, and don't repeat the same call.

- **"The person had this computer"**: a person took the desktop over and has handed it back, and your act was not
  done. The screen may have changed: observe again before you act.
- **A step refused as `unsupported`** names what this desktop can't do. Use another step.
- **The computer is gone or unreachable**: the run's desktop ended. Don't keep calling. Say what you finished and what
  you could not.

## Time and cost

The desktop lives only for the run's lifetime and may be billed while it runs. Make a short plan first: which app,
which steps, what will show success. Script what is certain, observe what is not, and stop once the task is done or
can't be done. Don't type secrets you were not given for this task.

## Finishing

Before you call the task done, check the result: an observe that shows it, or a screenshot when it is visual. Say what
it shows in your answer, and name anything you could not finish or check.
