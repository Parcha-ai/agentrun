---
name: phone-computer
description: Use a phone (a cloud Android or an iPhone) through the phone_tree, phone_screen, phone_tap, phone_swipe, phone_type, phone_key, phone_apps and phone_open tools. It covers looking, acting, checking what happened and recovering, and what a phone cannot do. Use when a run has a phone and the task needs its screen or apps.
---

# Using a phone

The run has a phone, a real one, rented while the run lives. You read its screen two ways: its structure (what can be
tapped or typed into, with exact positions) and screenshots. You act with one finger, a few keys, and its apps. Every
act answers in words, never with a picture, so you look again to see what an act did.

## The tools

| Tool | What it does |
|---|---|
| `phone_tree` | Lists what on the screen can be tapped or typed into, one line each: its class, its text or label, its id, whether it is a field (and focused), its **center** (to tap) and its bounds. |
| `phone_screen` | A screenshot of the whole screen. Its size in pixels is in the answer. |
| `phone_tap` `{x, y}` | One tap at that point. |
| `phone_swipe` `{from, to, duration_ms?}` | One finger from `from` to `to` (300 ms by default, at most 10 000). |
| `phone_type` `{text}` | Types the text into the field that has focus. |
| `phone_key` `{key}` | Presses `back` (leaves a page, closes a dialog or the keyboard), `home` (the home screen) or `enter` (submits the field in focus). |
| `phone_apps` | The installed apps by id, and which app is in front. |
| `phone_open` `{id}` | Opens an app by its id, on its first screen. |

**Coordinates are screenshot pixels**, origin top left, `x` to the right and `y` down, in whole numbers.
`phone_tree`'s centers and bounds are in the same pixels as `phone_screen`. A phone's screen is large (for example
720 x 1280) and its text is small, so tap a center from the tree rather than a point you estimate from a picture.

## The loop: look, act, check, recover

1. **Look.** Call `phone_tree` first. Find your target by its text, label or id, and note its center. Take
   `phone_screen` when the tree doesn't settle it: to see layout, images and colours, or to find a node that has no
   name in the tree.
   - A list row is often listed with no name, because the row's title is drawn by something inside it. Match the
     row's bounds to the screenshot to see which row it is.
   - The tree holds at most 150 nodes. Its last line counts any it left out: scroll, or use the screenshot.
2. **Act.** Do one act that changes the screen (a tap that opens something, a swipe, a key), then look again. Don't
   chain taps blind: once the screen changes under you, the second tap lands on something else.
3. **Check.** Take a screenshot or the tree again, and look for the change the act should have made:
   - after a tap on a list row: the list is replaced by that row's page;
   - after a swipe up: the rows have moved up;
   - after typing: the field holds the text.
4. **Recover.** If nothing changed, look closer before trying again. A dialog, the keyboard or a banner may cover
   your target, or the tap may have landed between two rows. Use the tree's center rather than a guess. After two or
   three tries that change nothing, change approach:
   - `phone_key` `back` to leave the page or close what covers it;
   - then `home`;
   - then `phone_open` the app afresh.

## What the screen looks like

- **A page's title may not be in the tree.** On current Android a page shows its title as a large heading in a header
  that shrinks as you scroll, and the header is a label, not something to tap. The page opened when its own items are
  in the tree and the list you tapped is gone. Don't wait for the title as a line in the tree.
- **The status bar** across the top (time, battery) is not the app.
- **The on-screen keyboard** appears when a field has focus and covers the lower part of the screen; what it covers
  cannot be tapped. `phone_key` `back` closes it.
- **Loading.** A screen may need a moment after a tap. If the screen hasn't changed yet, look again before acting.
  Don't repeat the tap, which may land on the new screen.

## Moving around

- **Scroll** with a swipe the opposite way to where you want to go. A swipe **up** (from low on the screen to high)
  moves a list **down**. Swipe in the middle of the list, from about 75% of its height to about 25%, then look again.
- **Long press**: `phone_swipe` with `from` and `to` the same point and `duration_ms` about 800.
- **Go back**: `phone_key` `back`, or the page's back arrow (in the tree as "Navigate up" on Android).
- **Open an app**: `phone_apps` gives the ids (like `com.android.settings`), then `phone_open` with one of them.
  - `phone_open` starts the app on its first screen, not where it was left, which makes it the surest way back to a
    known place.
  - Check with the tree or `phone_apps` that the app is in front.
  - An app may first show another app's screen (a sign-in or a permission prompt). Deal with that screen, then go
    on.

## Typing

1. Tap the field: `phone_tree` marks it "a field", and "focused" once it has focus.
2. `phone_type` with the text. `phone_key` `enter` submits it, or a line break in the text does.
3. Look again to read what the field holds now.

The phone types plain ASCII (letters, digits, punctuation, spaces) and line breaks; other characters are refused in
words before anything is typed. To clear a field, select its text if the app offers it, or open the page afresh.

## What a phone cannot do here

- No pinch or zoom, and no gesture with more than one finger.
- No keys beyond `back`, `home` and `enter`: no volume, no key combinations, no arrow keys.
- No shell, files or installs.

Don't fake any of these with tricks. Say in your answer what the task needed that the phone could not do.

## When a tool answers an error

Errors come in words, and they say what was wrong. Read them, and act on what they say. Don't repeat the same call.

- **A wrong argument** (a point outside the screen, an unknown key, a swipe too long): fix it and call again, once.
- **An app id the phone doesn't know**: list the apps with `phone_apps` and use an id from it.
- **"This phone does not offer its UI tree" or "its keys"**: this phone has no structure or keys to give. Work from
  screenshots, the page's own back arrows and `phone_open`.
- **"The person had this phone"**: a person took the phone over and has handed it back, and your act was not done.
  The screen may have changed, so look again before you act.
- **The phone is gone or unreachable**: the run's phone ended (its time ran out, or it was released). Don't keep
  calling. Say what you finished and what you could not.

## Time and cost

The phone may be billed by the minute, and it lives only for the run's lifetime. Work steadily:
- know what you want before each look;
- don't loop on screenshots or the tree just to wait;
- stop once the task is done, or once it can't be done.

A short plan before the first tap (which app, which screens, what will show success) saves more than fast tapping.

## Finishing

Before you call the task done, take a final screenshot that shows the result. Describe what is on it in your answer,
and name anything you could not finish or check.
