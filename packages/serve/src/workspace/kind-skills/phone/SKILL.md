---
name: phone-computer
description: Use a phone (a cloud Android) through the phone_screen, phone_tap, phone_swipe, phone_type, phone_apps and phone_open tools. It covers looking, acting, checking what happened and recovering, and what a phone cannot do. Use when a run has a phone and the task needs its screen or apps.
---

# Using a phone

The run has a phone: a real Android, rented while the run lives. You see it only through screenshots, and you act with
a finger: tap, swipe, type, and open apps. Every act answers in words, never with a picture, so you look again to see
what an act did.

## The tools

| Tool | What it does |
|---|---|
| `phone_screen` | A screenshot of the whole screen. Its size in pixels is in the answer. |
| `phone_tap` `{x, y}` | One tap at that point. |
| `phone_swipe` `{from, to, duration_ms?}` | One finger from `from` to `to` (300 ms by default, at most 10 000). |
| `phone_type` `{text}` | Types the text into the field that has focus. |
| `phone_apps` | The installed apps by id, and which app is in front. |
| `phone_open` `{id}` | Opens an app by its id, on its first screen. |

**Coordinates are the screenshot's pixels**, origin top left, `x` to the right and `y` down, in whole numbers. Take
them from the latest screenshot, not from memory and not from another device's layout. A phone's screenshot is large,
for example 720 x 1280, and its text is small: aim at the middle of what you want, not at its edge.

## The loop: look, act, check, recover

1. **Look.** Take `phone_screen` before you act, and again whenever an act may have changed the screen. Find your
   target and its middle in pixels.
2. **Act.** Do one act that has a visible effect (a tap that opens something, or a swipe), then look again. Don't
   chain taps blind: a screen that changed under you turns the second tap into a tap on something else.
3. **Check.** Compare the new screenshot with the one before, and look for the change the act should have made. A tap
   on a list row should replace the list with that row's page. A swipe up should move the list's rows up. Typing should
   show the text in the field.
4. **Recover.** If nothing changed, look closer before trying again: a dialog, a keyboard or a banner may cover your
   target, or the tap may have landed on the gap between two rows. Try a different point once. After two or three
   tries that change nothing, change approach: open the app afresh (below), or take another way to the same screen.

## What the screen looks like

- **Page titles collapse.** On current Android, a page you open often shows its title as a large heading at the top,
  in a header that shrinks into a small bar as you scroll. Don't wait for the title in one exact place. The page opened
  if the list you tapped is gone and the page's own items are there.
- **The status bar** across the top (time, battery) is not the app. Don't tap there to reach the app's top.
- **The on-screen keyboard** appears when a field has focus, and covers the lower part of the screen. What it covers
  cannot be tapped. Scroll the page so your target sits above it.
- **Loading.** A screen may need a moment after a tap. If the screenshot shows the old screen or a spinner, take
  another screenshot before you act again. Don't tap again at once: a second tap may land on the new screen.

## Moving around

- **Scroll** with a swipe the opposite way to where you want to go. A swipe **up** (from low on the screen to high)
  moves a list **down**. Swipe in the middle of the list, from about 75% of its height to about 25%, at an even
  speed. Look after each swipe.
- **Long press**: `phone_swipe` with `from` and `to` the same point and `duration_ms` about 800.
- **Go back**: there is no back or home button among the tools. Tap the page's back arrow (usually at the top left),
  or use `phone_open` to start the app again.
- **Open an app**: `phone_apps` gives the ids (like `com.android.settings`), then `phone_open` with one of them.
  `phone_open` starts the app on its first screen, not where it was left: its earlier screens are cleared. That makes
  it the surest way back to a known place. After opening, check with a screenshot or `phone_apps` that it is in front.
  An app may first show another app's screen (a sign-in or a permission prompt); deal with that screen, then go on.

## Typing

1. Tap the field, then take a screenshot to check that it has focus: a cursor, the keyboard, or a highlight.
2. `phone_type` with the text. A line break in the text presses enter, which often submits a form or a search.
3. Look again to read what the field holds now.

The phone types plain ASCII (letters, digits, punctuation, spaces) and line breaks. Other characters are refused in
words before anything is typed. To clear a field, select its text if the app offers it, or open the page afresh.

## What a phone cannot do here

- No pinch or zoom, and no two-finger gestures: the phone takes one finger.
- No hardware keys (back, home, volume) and no key combinations.
- No view of the screen's structure, its elements and their ids. You have screenshots only, so read the screen as a
  person would.
- No shell, files or installs.

Don't fake any of these with tricks. Say in your answer what the task needed that the phone could not do.

## When a tool answers an error

Errors come in words, and they say what was wrong. Read them, and act on what they say. Don't repeat the same call.

- **A wrong argument** (a point outside the screen, a missing id, a swipe that is too long): fix the argument and call
  again once.
- **An app id the phone doesn't know**: list the apps with `phone_apps` and use an id from it.
- **"The person had this phone"**: a person took the phone over and has handed it back, and your act was not done. The
  screen may have changed, so take a screenshot before you act again.
- **The phone is gone or unreachable**: the run's phone ended (its time ran out, or it was released). Don't keep
  calling. Say what you finished and what you could not.

## Time and cost

The phone is billed by the minute, and it lives only for the run's lifetime. Work steadily:
- Know what you want to check before you take each screenshot.
- Don't take screenshots in a loop just to wait.
- Stop once the task is done, or once it can't be done.

A short plan before the first tap (which app, which screens, what will show success) saves more minutes than any fast
tapping does.

## Finishing

Before you call the task done, take a final screenshot that shows the result. Describe what is on it in your answer,
and name anything you could not finish or check.
