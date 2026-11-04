---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A capped run that the person stops can go on. A request you stop now counts what it streamed, plus up to 1,024 output tokens the provider may have produced after the last word we read, and never more than it was held. Before, it counted at its whole hold. Since each request is limited to what is left of the cap, that hold was the rest of the cap. So a $1 run stopped after $0.004 of spend read $1 spent, and its next message failed with `spend_cap_reached`.
- **On pi:** a stopped request counts its input bound, each byte of text, thinking and tool calls it streamed as a token, and `STOP_ALLOWANCE_TOKENS` (1,024) of output, at the model's price, at most its hold. Its end mark (`agentrun.request_ended`) carries that figure as `heldUsd`, so a later process counts it the same.
- **On `claude-agent` and `codex`:**
  - The model proxy reports a response its client left part way, its cost unknown, with the bytes it had sent (`stoppedAfterBytes`).
  - A runner `beforeRequest` may answer `stoppedUsd(streamedTokens)` beside `holdUsd`. The runner counts such a response at the lesser of the two and writes the figure on its `runner.turn` (`heldUsd`, `stopped: true`).
  - A response the provider ended early, or one cut by a crash, still counts at its hold.
- **Unchanged:** a request that ended on an error after its response began, a failed summary and a crash cut still count at the hold. The run's shown cost is unchanged: a stopped request reads unknown, beside its cost so far.
