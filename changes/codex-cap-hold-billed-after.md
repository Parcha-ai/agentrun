---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: fix
---
A Codex run under a small spend cap no longer stops as early on a hold that overstated its next request.

A request that only adds items to the session's last billed request is now held at that bill plus the bytes of the items it adds, with the local count's margin. The bill is all of that request's `input_tokens`, cached tokens included. Any other difference falls back to the local count, as before: changed instructions, tools, reasoning or model, or an earlier item edited, removed or moved.

Once the run has seen its model reason, a request's least output is 1,024 tokens plus twice the most reasoning one answer reported, within its effort's allowance. Before that it is the whole allowance, as before.

The request is still sent with all the output the cap fits, and the hold is still its worst case, so the cap is never passed. When the provider cuts an answer at the output the cap limited it to, the turn says so. A final answer cut that way ends the run with "the run's $0.50 cap stopped the model at N tokens before it finished its answer: raise the cap to at least $X to let it finish", where $X is the cap that sends that request whole.
