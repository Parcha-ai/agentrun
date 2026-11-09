---
packages: @parcha/agentrun-serve
kind: fix
---
`market-monitor` no longer reports a wrong pricing URL as a blocked source: a 404 at the guessed `/pricing` (Middesk's, from human QA on Render) sends it to the home page's links for the real pricing page, which it keeps in a learned note, and a company with no public pricing page is said to have none.
