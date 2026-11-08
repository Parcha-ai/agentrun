---
packages: repo
kind: fix
---
The console's flows are tested in a real browser against the built server (apps/console/e2e, `npm run test:e2e`, CI's `console-e2e` job). Each flow starts the server's own CLI on 127.0.0.1 with a fresh data dir and home, then drives headless Chrome through playwright-core, so the page loads with the server's real headers, CSP, cookies and redirects. The first flows are setup without a public URL and sign-in. The others are listed as pending with what they wait on. Nothing leaves loopback, and every wait is on a selector, a response or the server's output, never a clock.
