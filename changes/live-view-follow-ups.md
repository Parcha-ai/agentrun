---
packages: @parcha/pi-browser, @parcha/agentrun-serve
kind: fix
---
Live view and take-over follow-ups: the watch-only viewer reads as watching, the page fills the viewer's window, a broken connection never writes an HTTP line into an open viewer, and two take-over notices say what happened.
- A view-only viewer shows "View only: you're watching the agent's browser; your clicks and keys are not sent." in a banner of its own, with the page's address beside it as plain text (cut with an ellipsis, the whole address in its tooltip), never the take-over wording that input is held, and no toolbar (its back, reload and address field acted on nothing there).
- In every mode the page fills the window at its own shape and follows it as the window resizes, with clicks still landing where they are made; the end of a session (released, refused or disconnected) reads in large type over a dimmed page.
- A run's live view whose browser connection breaks mid-session just closes the viewer's WebSocket: the server no longer writes an HTTP "502" (or "500") line into a WebSocket stream already open.
- A take-over whose hold ended before it went live (the agent's step ran on) says "Your take-over did not start: …" instead of that the browser went back to the agent, which the person never had.
- A live view whose gate registry cannot hold refuses a take with "This browser can't be handed over from the live view." instead of telling the person it is held already.
