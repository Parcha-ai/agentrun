---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: feature
---
The runner now writes a warn line when a paid model request bills more input than the bound its spend-cap hold was priced on: the one way a cap can be passed, a hold that was too small.

The line is `event=cap_hold_short`, in the same logfmt shape as the server's other log lines, written to stderr once for each such request as its answer is booked: by an agent's run, by a workflow run's model nodes (harness `workflow`) and by a learning grade (harness `grade`), and for a request that answered after its run's claim was lost, by the booking that writes it later. It carries the run id, the request's session and turn, the harness, the model, the bound and the billed input in tokens (input, cache reads and cache writes together), and in USD what was held, what the answer billed and the shortfall (billed less held) when the answer was priced.

No line is written for a request billed at or under its bound, for one whose answer reported no usage, for one billed to a ChatGPT plan or on a free model (held at $0 whatever its input), or for one with no hold (no cap). The line carries ids and figures only: never any prompt or answer text, header, key or token. Billing, holds and refusals are unchanged.
