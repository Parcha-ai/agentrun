---
packages: @parcha/agentrun-harness
kind: fix
---
A demo may set its Jev token cap (`models.judge.caps.tokens` in demo.json) up to 2,560,000 tokens, up from 160,000. One Jev request with three images is about 10,000 tokens, so an image demo at the old ceiling ran out of tokens after about 16 of its 200 requests and its later decisions were never asked. The request ceiling stays 200, the defaults stay 50 requests and 40,000 tokens, and `--max-usd` still applies.

A request the judge seam refuses at a cap (`JEV_CAP_REACHED`) now carries `requestDiagnostic: { reason: 'cap_reached' }`: it was never sent, so pi-vision files it at $0 instead of as a price unknown, and a run that hits a Jev cap still reports its cost.
