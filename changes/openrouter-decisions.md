---
packages: @parcha/agentrun-decisions, @parcha/agentrun-dsl, @parcha/agentrun-jev
kind: feature
---
**OpenRouter's Decisions models answer decision nodes, and four-place probabilities are accepted**
- `openrouterProvider()` in `@parcha/agentrun-decisions` sends a decision to any OpenRouter Decisions model (`POST https://openrouter.ai/api/v1/systemone`) named by the node's `model`, such as `liquid/d1`, `perplexity/pplx-decider-v1.2`, `cloudflare/clef` or `typesafe/jev-1.14`. A node that names no model is refused before sending. The response's `usage.cost` is booked as reported, else the cost is unknown. A request is sent again only when it never reached OpenRouter or on a 429 with `Retry-After`; one lost after sending is `outcome_unknown`. Its key is `OPENROUTER_API_KEY`.
- Images to OpenRouter (experimental) go in the JSON body as base64 `assets`, only to a model the public catalog lists with image input. Jev takes an image token anywhere in the state or a question, at most 1568 px on a side; every other model only as a whole top-level state value, sent as an item of an array state. A token placed anywhere else is refused before sending.
- `@parcha/agentrun-decisions/testing/faux-system-one` is a fake System One endpoint for a host's tests and rehearsals.
- `parallelProvider({ modes })` lists the Parallel modes a node may pin as `parallel-<mode>` (default `PARALLEL_MODES`, `["fast"]`); a node that pins none asks the first.
- `validateAnswers` accepts probabilities rounded to two, three or four places: a value may be off by half its grid's step. Cloudflare's `clef` reports four places (a distribution summing to 0.9999), which was refused as `probability_mass`.
- `jevProvider`'s refusal of images on its OpenRouter route names the way that works: the `openrouter` provider with `typesafe/jev-1.14`.
