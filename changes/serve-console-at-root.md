---
packages: @parcha/agentrun-serve
kind: feature
---
`/` is the console (`apps/console`), and the server's own page is retired: its HTML, `serve.js`, `serve.css`, its setup and sign-in pages, and the store page's files it loaded (`/page.css`, `/page.js`, `/graph.js`). The store's read-only JSON under `/api/*` keeps answering as before, for the token or the browser's cookie.
- The console's assets are under `/assets/`, with the same CSP and headers it had at `/console/`. `/console/`, and the old `/setup` and `/sign-in` that the printed setup link still names, send the browser to `/` with a 303, and a link's `#code` stays with it. The console runs its own setup and sign-in.
- Without accounts, the printed `/?token=` link still sets the browser's cookie once and sends it to `/`. Without that cookie, `/` is the console, which says to open the link; a wrong token answers 401 and sets nothing.
- A server built without the console answers `/` with a 404 that says so.
