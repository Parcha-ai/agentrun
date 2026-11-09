---
name: desktop-computer
description: Use a desktop computer through the desktop_screen and desktop_input tools. It covers looking, acting with the pointer and the keyboard in batches, checking what happened, recovering, and reading the computer's refusals. Use when a run has a desktop and the task needs its screen, its apps or its windows.
---

# Using a desktop

The run has a desktop: a computer with a screen, a pointer and a keyboard, rented while the run lives. You see it
through screenshots and act on it as a person would, with the mouse and the keys. Input answers in words, never with a
picture, so you take a screenshot to see what your actions did.

## The tools

**`desktop_screen` `{region?}`** takes a screenshot. With no region, it shows the whole screen, and the answer gives
its size in pixels. With `region: {x, y, w, h}`, it shows only that part, sharper for small text. The coordinates stay
the whole screen's: a button you find in a region is clicked at its whole-screen point.

**`desktop_input` `{actions}`** runs a list of 1 to 100 actions, in order:

| Action | Fields | What it does |
|---|---|---|
| `move` | `at` | Moves the pointer there. |
| `click` | `at?`, `button?` (`left`, `right`, `middle`), `count?` (1, 2, 3) | Clicks at `at`, or where the pointer is. `count: 2` is a double click. |
| `drag` | `path` (2+ points), `button?` | Presses at the first point, moves through the rest, releases at the last. |
| `scroll` | `at?`, `dx?`, `dy?`, `unit` (`clicks` or `px`) | Scrolls there. `dy` above 0 scrolls down. Wheel clicks are the usual unit. |
| `type` | `text` | Types the text, as given, into what has focus. |
| `key` | `keys` | Presses one key, or several together as a combo: `["ctrl", "c"]`. |

A key is a name or one printable character. The names are: `enter`, `tab`, `space`, `backspace`, `delete`, `escape`,
`insert`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1` to `f12`, `shift`, `ctrl`, `alt`,
`super` and `capslock`. A character is one printable character, such as `"a"`, `"A"` or `"/"`. Use `type` for words,
and `key` for keys and combos.

**Points are `[x, y]` in screenshot pixels**, origin top left, `x` to the right and `y` down. Take them from the latest
screenshot, and aim at the middle of what you want.

## The loop: look, act, check, recover

1. **Look.** Take a screenshot first, and again after anything that may change the screen. To read small text (a
   menu, a field, a status line), take a region screenshot of it.
2. **Act.** Put actions in one batch when you know what each will do without seeing the screen between them: click a
   field, type, press `enter`. End the batch where you need to see the result. A click that opens a menu or a new
   window ends a batch: the next point depends on what opens.
3. **Check.** Take a screenshot and look for the change the actions should have made. That might be the text in the
   field, the menu open, the window moved, or the page loaded. A batch that finished without an error only says the
   computer ran the actions, not that the app did what you meant.
4. **Recover.** If nothing changed, find out why before you try again:
   - Maybe another window or a dialog is in front.
   - Maybe the click landed beside the target.
   - Maybe the app is still busy.
   Try a better point once. After two or three tries that change nothing, change approach: use the keyboard instead
   of the pointer (`tab` to move, `enter` to press), a menu instead of a button, or close and reopen the app.

## Habits that work

- **Focus before typing.** Click the field, then type. Typed text goes to whatever has focus, which may not be the
  field you see.
- **Prefer the keyboard where it is exact.**
  - `ctrl` + `a` selects all.
  - `ctrl` + `l` focuses a browser's address bar.
  - `escape` closes a menu or a dialog.
  - `alt` + `f4` closes a window.
  - `enter` confirms.
  Shortcuts don't depend on where things are drawn.
- **Scroll where the content is.** A scroll goes to what is under its point. Put `at` on the list or the page you mean,
  not on a sidebar.
- **Wait by looking.** If a page or an app is loading, take another screenshot before you act. Don't repeat a click
  while the screen is still changing: the second click may land on the new screen.
- **Windows.** If the window you need is behind another one, click its visible part or its taskbar entry, or use
  `alt` + `tab`. Then look again to check that it is in front.
- **Dialogs first.** A dialog, a notice or a cookie banner blocks what is under it. Read it, answer it or close it,
  then go on.

## When a tool answers an error

Errors come in words, and they say what was wrong. Read them, and act on what they say. Don't repeat the same call.

- **A malformed action** (an unknown key name, a point that is not two numbers, an action that is not one of the six):
  the whole batch is refused, and nothing ran. Fix the action the words name, and send the batch again.
- **A batch that failed partway** says how many actions ran. Take a screenshot, see where it stopped, and go on from
  there. Don't resend the actions that already ran.
- **More than 100 actions**: split the batch.
- **"The person had this desktop"**: a person took the desktop over and has handed it back, and your input was not
  done. The screen may have changed, so take a screenshot before you act again.
- **The computer is gone or unreachable**: the run's desktop ended (its time ran out, or it was released). Don't keep
  calling. Say what you finished and what you could not.

## What not to do

- Don't guess coordinates from memory of another screen or another resolution. Use this screenshot's pixels.
- Don't send a long batch blind across screens you have not seen. One wrong click early sends the rest astray.
- Don't take screenshots in a loop just to wait. Each one takes time, and the desktop's time is limited and may be
  billed.
- Don't type secrets you were not given for this task, and don't change the computer's settings beyond what the task
  needs.

## Time and cost

The desktop lives only for the run's lifetime, and may be billed while it runs. Make a short plan before the first
action: which app, which steps, and what will show success. Batch what is certain. Stop once the task is done, or once
it can't be done.

## Finishing

Before you call the task done, take a final screenshot that shows the result. Describe what is on it in your answer,
and name anything you could not finish or check.
