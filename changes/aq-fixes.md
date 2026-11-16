---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
Three fixes from the computer milestone's QA: `apps.launch` no longer says it opened a url that a running Firefox never got, the Screen tab no longer says "released" right after a person allows a parked run, and the "Asked your approval" row sits above a park's rows on the Timeline.
- computerd: a url for an app that already runs is handed over by a second launch. Firefox takes it only over a session bus, and an app here has none, so that launch put up Firefox's "Firefox is already running" box while the call answered that it opened. Now a launch that shows a dialog of its own instead, or whose launcher fails, is ended (its box goes) and the call fails `unsupported`, naming the dialog and saying to open the url in the running window or to terminate the app and launch it with the url. A launcher that hands the url over and ends (Chromium's), or a second instance with a window of its own, still answers.
- Console: a desktop or phone kept at a park is opened again by the resume, so after an answer in time the Screen tab says "Waiting for the desktop. Its screen shows here once it is up." until the screen is back, not "This desktop has been released.". A page opened on a parked run now says what the run waits for and until when, even if it never saw the desktop live.
- Timeline: the approval row sits right below its call's row, as the ask came at the call. A park's "The desktop is kept…" row and the resume's "It's the same desktop, as the wait left it." row now come after it, not before.
