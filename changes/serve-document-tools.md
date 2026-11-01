---
packages: @parcha/agentrun-serve, @parcha/agentrun-pi
kind: feature
---
**Workflows on AgentRun Server read documents, call one completion, judge images, and run code nodes when allowed**
- `pdf_pages`, a workflow call tool: `{ path, maxPages?, dpi? }` draws a document's first pages as PNGs under the run's `work/pages/<stem>/<dpi>/` (long side at most 1568 px, Jev's largest) with its text. A PNG or JPEG passes through, scaled down if larger. `path` is confined to `--documents DIR` (or `AGENTRUN_SERVE_DOCUMENTS`) and the run's `work/`. Needs poppler's `pdftoppm` and `pdftotext`.
- `llm`, a workflow call tool: one completion on the run's model of the call's tier, no tools and no loop: `{ text, model, usage, cost_usd }`, the cost null when the model has no price.
- Both are call-only: an agent or a model node naming them is refused (`422`), and `GET /capabilities` marks them `call_only`.
- Decision nodes' `images` are loaded from the run's `work/`. Nodes naming `provider: "openrouter"` run on OpenRouter's Decisions models, on the OpenRouter key Jev's OpenRouter route reads (`OPENROUTER_API_KEY`, else the gateway's `AGENT_MODEL_API_KEY` on openrouter.ai), handed on the decision descriptor; capabilities list `openrouter` among the providers (under `faux`, startServe's `fauxOpenrouter` fakes it).
- A call tool that fails on its own fails that item in a collecting `map` instead of the run.
- `code` nodes run only on a server started with `--allow-code-nodes` (or `AGENTRUN_SERVE_CODE_NODES=1`): they run in the run's process through `new Function`, which is no sandbox. Off (the default), such a workflow saves with a `not_set_up_here` warning and its runs are `409 agent_not_runnable` with `details.code: true`. Calls via a shell or the executor stay refused.
- Pi's decision rows keep a receipt's images (by digest), the state the judge saw and its cost basis, and a replay returns them.
