---
packages: @parcha/agentrun-web
kind: feature
---
The web classifier step is split in two: the decider only asks, giving each result or passage a score (`p(needed)`, or null where refused), and the step decides what the model reads. `WebConfig.policy` picks how: `"drop"`, the default, byte-identical to the step before the split; `"label"`, which keeps every search result in the provider's order, each labelled `relevance` (0 to 1); or `"rerank+label"`, which labels them and puts the most relevant first. Under either of the last two, one line computed in code says when none reaches `LOW_RELEVANCE`: nothing here looks relevant to the query; consider rephrasing. Every `receipt.classifier` now records each item's score in `scored`. `web.fetch(url, { lookingFor })` scores the chunks of the whole cached page against what the agent says it is looking for and answers the `FOUND_CHUNKS` likeliest in page order, each at its offset; without `lookingFor` a fetch is unchanged.
- `deciderFrom` no longer takes `threshold`, and a `Verdict` is `{ score }`: the drop rule is the step's `THRESHOLD`.
- TODO: labels carry scores only. A reason per item needs a question type beyond noul, which would break the same-questions invariant (`decider.ts`), so it waits for its own change.
