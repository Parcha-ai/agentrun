---
packages: @parcha/agentrun-serve
kind: docs
---
A dev kit for working on the page, in `packages/serve/dev/` (not published, not in the image):
`npm run dev -w @parcha/agentrun-serve` seeds sample data on a scripted faux model (six agents of both kinds, eleven
revisions, 35 runs in every state, no key and no network) and serves it on 127.0.0.1 with the page's files read from the
source on every request. `/storyboard.html` on that port shows every screen live at desktop and phone width, with the
states each must handle. `dev/README.md` says how to run, test and style the page.
