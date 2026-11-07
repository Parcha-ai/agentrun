---
packages: @parcha/pi-browser
kind: fix
---
A page request the browser loses before it is sent is told to the call, so the model can send it again. Chrome sometimes restarts its network service while the effect observer holds requests, more often on a busy machine. A request still on its way at that moment was never sent, and the page may never hear of it. `run` and `browser_upload` now say so in plain words ("The browser lost a request your page sent before it left the browser: POST https://…/path … it was NOT sent and nothing reached the site"), and list it in `details.lost` by method and URL, with no query, body or header.
- `EffectObserver.record(listener, lost?)` takes a second listener, which hears of each lost request (`requestId`, `method`, `origin`, `path`) while the call records.
- A lost request is never journaled, so it never counts as sent or allowed. If Chrome pauses it after all, it is refused and journaled denied. The observer holds and denies every request after the restart as before.
- The observer asks Chrome for its network service's pid only while a held request waits for its pause: once per request, then every 250 ms while it waits, never when idle, and never for an observer that holds nothing. A browser that refuses the question, or names no network service of its own for 2 s, is not asked again. Over the 12-case effect matrix under deny that was 16 questions of about 3 ms each.
- A form POST lost before its request existed is told by its frame's intent; if its Document request is paused after all, it is refused.
