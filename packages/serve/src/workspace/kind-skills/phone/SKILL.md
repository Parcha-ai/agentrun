---
name: phone-computer
description: Use a phone (a cloud Android or an iPhone) through computer_observe, computer_act, computer_screenshot and computer_script. It covers reading the screen's elements, acting on them by ref, running known steps as one script, checking what happened, recovering, and what a phone cannot do. Use when a run has a phone and the task needs its screen or apps.
---

# Using a phone

The run has a phone, a real one, rented while the run lives. Where it lists its elements (the `ui` group, an Android's
today), you read the screen as lines of elements and act on them by their refs. Where it doesn't (an iPhone today), you
see it through screenshots and act with one finger at their pixels. The tools say which one you have.

## The tools

**`computer_observe` `{app?, image?, full?}`** shows the app in front as compact lines, one per element:

```
state s2 · com.android.settings "Settings" · window 360×800 pt
@e1 generic
  @e3 searchbox "Search settings"
  @e5 button "Network & internet"
  @e9 button "About phone"
```

Each line is a ref (`@e5`), a role, a name, a value after `=`, what else the element says in parentheses (a row's
second line: `("Mobile, Wi-Fi, hotspot")`) and flags in brackets. A child is indented under its parent. The head line names the **state**. `image: true` adds a screenshot, for what the elements can't tell you:
layout, images, colours. Without the `ui` group, observe is the screenshot.

**`computer_act` `{steps, state?, expect?, observe?}`** runs steps in order:

| Step | What it does |
|---|---|
| `{press: "@e9"}` | The element's own tap. The surest step. |
| `{set: "@e3", value: "wifi"}` | Sets a field's text, or a switch's `"on"` or `"off"`. |
| `{click: "@e9"}` or `{click: [x, y]}` | A tap; `button: "right"` is a long press. |
| `{type: "text", into?: "@e3"}` | Types, into the element when named, else into the field in focus. |
| `{nav: "back"}`, `{nav: "home"}`, `{nav: "app_switch"}` | The system's own navigation. |
| `{scroll: "@e1", dy: 600}` | Scrolls the element by points: `dy` above 0 shows what is below. |
| `{drag: [[x1, y1], [x2, y2]], ms?}` | One finger along the path. |
| `{key: "enter"}` | A key, where the phone has keys. |

Each step answers its route and whether a readback verified it; the answer ends with whether the screen changed and its
new state. `expect: {text: "Android version"}` waits after the steps until that text shows (`gone: true`: until it is
gone). `observe: true` adds the new outline: one call instead of two. The first refused step stops the rest.

Prefer refs. A step at a point is read against a state and refused as **stale** once the screen moved under it:
observe again and use the new state. Without the `ui` group, points are screenshot pixels and there are no refs,
states or expects.

**`computer_screenshot` `{region?}`** is the whole screen, or `region: [x, y, w, h]` of it, in pixels.

**`computer_script` `{code}`** runs JavaScript in an isolate whose only binding is `computer`. Its tool description
gives the `computer` object's types for this phone. The body is an async function: `await` the calls and `return` what
you need.

```js
await computer.apps.open("com.android.settings");
const settings = computer.app("com.android.settings");
await settings.observe();
const about = settings.find({ text: "About phone" })[0];
const page = await settings.press(about.ref, { expect: { text: "Android version" }, observe: true });
return { met: page.expect, lines: page.after.outline.split("\n").filter((line) => /version/i.test(line)) };
```

**Your harness's own code mode.** pi's `codemode` binds `computer` as computer_script does. Codex's `exec` does not:
there, call the tools, each answering its value as JSON text, or call `tools.computer_script` with the code above.

```js
const page = JSON.parse(await tools.computer_observe({ app: "com.android.settings" }));
const about = page.elements.find((node) => node.name === "About phone");
```

## How to work: observe, then act by ref, then check

1. **Observe** first. Find your target by its name, role or id, and note its ref. A list row is often an unnamed
   button whose title sits on a child text: the outline shows it indented under the row.
2. **Act** by ref. A step that changes the screen (opening a page, a back) ends the call, unless you put an `expect`
   on it for what the next screen shows.
3. **Check** the answer's routes, `changed` and the expect. When it doesn't settle it, observe again.
4. **Recover.** `stale`: observe again. Nothing changed: a dialog, the keyboard or a banner may cover the target.
   `{nav: "back"}` closes what covers it; `computer.apps.open(id)` in a script starts an app afresh on its first
   screen, the surest way back to a known place.

## When to write a script

- **Known steps**: open an app, press through a known path, read one value: one script, an `expect` on each page.
- **A few facts out of a long screen**: `find()` inside the script and return only those, never whole observations.
  `find({ role, text, id })`: a role is the same name on every phone, a text matches the name, the value or what the
  parentheses say, and an id is the app's own (an Android resource-id).
- **Loops**: scroll a list until a row shows.

When you are unsure what is on the screen, observe before you act, and decide from what it shows.

## What the screen looks like

- **A page's title may not be an element.** On current Android the title is drawn in a header that shrinks as you
  scroll. The page opened when its own items show and the list you pressed is gone.
- **The keyboard** covers the lower part of the screen while a field has focus; `{nav: "back"}` closes it.
- **The status bar** across the top (time, battery) is not the app.

## What a phone cannot do here

- No pinch or zoom, and no gesture with more than one finger.
- No shell, files or installs.
- Plain ASCII typing only: other characters are refused in words before anything is typed.

Say in your answer what the task needed that the phone could not do.

## When a tool answers an error

Errors come in words, and they say what was wrong. Read them, act on what they say, and don't repeat the same call.

- **"The person had this computer"**: a person took the phone over and has handed it back, and your act was not done.
  The screen may have changed: observe again before you act.
- **A step refused as `unsupported`** names what this phone can't do (an element step without the `ui` group, a key
  on a phone with no keys). Use another step.
- **The phone is gone or unreachable**: the run's phone ended. Don't keep calling. Say what you finished and what you
  could not.

## Time and cost

The phone may be billed by the minute and lives only for the run's lifetime. Plan first (which app, which screens,
what will show success), script what is certain, and stop once the task is done or can't be done.

## Finishing

Before you call the task done, check the result with an observe (or a screenshot when it is visual). Say what it shows
in your answer, and name anything you could not finish or check.
