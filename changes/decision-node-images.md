---
packages: @parcha/agentrun-dsl, @parcha/agentrun-jev
kind: feature
---
**Decision nodes send images, receipts keep what the judge saw, and a map collects its items' failed decisions**
- `judge`, `pick`, `sift`, a judged `route` and an `ask` predicate take an optional `images: { "<token>": <reference> }`. The token must appear literally in the node's `state` or in a question's text; the reference is written as a state value is (`"{item.pages.0.image}"`) and resolves to an image path the host reads. The schema, `inspectWorkflow`, `workflowGraph` and the author contract know the field.
- `judgeFromProvider(provider, { deadlineMs, loadImage })` and `judgeFromProviders({ ..., loadImage })` read a request's images through the host's `loadImage(ref, { signal })` before anything is sent. A provider without `image` in its inputs, a host with no `loadImage`, or an image that cannot be read is refused, and no request is made. `DecisionRequest.images` carries `{ bytes, mime, ref }` by token.
- A decision receipt names each image as `{ token, ref, sha256, mime, bytes }`, never its bytes, and keeps the state the judge saw (`state`, past 64 KB of JSON its first 64 KB with `state_truncated: true`) and its `cost_basis`.
- `imageDimensions(bytes)` reads a PNG's or JPEG's width and height from its header. `jevProvider` takes image input on TypeSafe's own API (as Jev assets, with the `TypeSafe-Danger-Zone-Images` header) and refuses an image over 1568 px on a side before the paid call, the largest Jev answers.
- `jevProvider` sends a request again only on a 429 with `Retry-After` or a connect error before sending (up to `maxAttempts`, default 3). A 408, a 5xx or a connection lost after sending stays `outcome_unknown`, never sent twice.
- Inside a `map` with `onItemFailure: "collect"`, a decision whose provider fails (rate limit, HTTP error, invalid answer, timeout) fails that item, and one whose outcome was lost, or that the provider refused, ends the item `needs_review`. The other items go on; before, any of these failed the run.
