---
packages: @parcha/agentrun-harness
kind: fix
---
A demo may set its Jev caps (`models.judge.caps` in demo.json) up to 800 requests and 2,560,000 tokens, up from 200 and 160,000. One Jev request with three images is about 10,000 tokens, so an image demo at the old ceiling ran out of tokens after about 16 of its 200 requests; with tokens raised, a vision run that boxes about 140 items and grounds about 100 rows ran out of requests. The defaults stay 50 requests and 40,000 tokens, and `--max-usd` still applies.

A request the judge seam refuses at a cap (`JEV_CAP_REACHED`) now carries `requestDiagnostic: { reason: 'cap_reached' }`: it was never sent, so pi-vision files it at $0 instead of as a price unknown, and a run that hits a Jev cap still reports its cost.
