---
packages: repo
kind: docs
---
`examples/decision-demos` holds five decision workflows that run on AgentRun Server with no agent loop: one document's validity from its page images (Jev), a batch of 20 documents through a map with a written report, a KYB check that crosses Parallel's web-grounded registry answer with Jev's reading of the documents, a merchant's category and prohibited-goods check from its web page, and one question to a jury of Jev and three OpenRouter Decisions models. The documents are for invented companies, labelled for scoring. `run.mjs` starts the server from the checkout (with `--allow-code-nodes`), makes the five agents and runs a use case on fakes of every provider, or live with `--live`; `validate.mjs` and `rehearse.mjs` check and rehearse them offline.
