---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-client
kind: feature
---
A run on a free model or a ChatGPT plan now stops at 60 model requests. Every such request costs $0, so no spend cap could stop one stuck in a loop: a run on a free model made 520 web searches before it ended. The request after the 60th is not sent, and the run ends `failed`, as one its cap ends, with error `spend_cap_reached`: "Not sent: this run reached its 60-request limit for free models." The limit holds capped or not, on every harness, and no raise lifts it. A server that needs more sets `AGENTRUN_FREE_MODEL_REQUESTS` (a whole number above 0; anything else refuses the start).
- What counts: each request priced $0 the run makes, its subagents' and side calls' included, and one a crash cut. A paid request, a paid tool call and a workflow's decision never count.
- A free request a crash cut is now booked at $0, a known cost, where it was booked as unknown.
- Capabilities report the limit as `limits.free_model_requests` (marked `freerequests/1`), and the console says "free model: up to 60 requests" beside the spend cap of an agent on a free model or a plan.
- Kernel: `runCap` takes `freeRequests`, and `kernel/cap` exports `zeroPricedOf`, `planCapModel`, `freeModelRequestsOf` and `freeCeilingEnd`. A runner's `runner.request` record says `zeroPriced` (`"free"` or `"plan"`) for such a request.
