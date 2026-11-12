---
packages: @parcha/agentrun-serve, @parcha/pi-browser
kind: fix
---
A run that asks its person a question with its browser open keeps that browser while it waits, for the person's window, `AGENTRUN_BROWSER_PERSON_WAIT_MIN` (15 minutes by default; the same setting now bounds a take-over with no input and an agent's hand-over ask). Before, the browser's own 3-minute idle release let it go while the run waited, so the page, the live view and Take over were gone just when the person might use them. At the window's end the browser is released with a timeline row saying so ("The browser was released after 15 min waiting for you"), and an answer after that opens a new browser. The Screen tab says the browser was released, and when, instead of "Waiting for the browser" (GET /v2/runs/{id}/computer's `none` carries `ended: {at, why}`). pi-browser's extension handle gains `keepForPerson(tag)`, which holds a session from its idle release until let go.
