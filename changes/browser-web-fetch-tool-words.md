---
packages: @parcha/pi-browser, @parcha/agentrun-serve
kind: fix
---
A model granted both web_fetch and the browser is now told which one has cookies. Asked to "Open https://httpbin.org/cookies", a pi run picked web_fetch, which has no cookies, and answered with an empty page; it picked the browser only when told to. The tool descriptions the model reads now say:
- **web_fetch** has no cookies, sign-ins or session: it reads one page cold, so a page behind a sign-in, or one that depends on an earlier page, needs the browser tool, where this run has it. That holds for serve's web_fetch on every harness and for pi-browser's.
- **The browser's `run`** keeps this agent's saved sign-ins and cookies, for anything behind a sign-in or a page that depends on an earlier one. It says this only on a run that has a saved sign-in: in serve, a run handed its agent's sign-in; in pi-browser, a host that passes `signIns: true` or a session vault. Without one it says only that the browser keeps cookies across pages, which stays true for a local Chrome, which keeps no saved sign-in.
- **pi-browser** adds `browserToolsFor(signIns)` (the browser's contracts with `run`'s words for that plane), `BROWSER_KEEPS` (the two sentences), and the durable extension's `signIns` option.
