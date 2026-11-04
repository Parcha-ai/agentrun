---
packages: @parcha/agentrun-serve
kind: feature
---
`PATCH /runs/{run_id}` with `{max_cost_usd}` raises a run's spend cap, and only raises it. The new cap must be above the run's own. It is `422` otherwise, and for a run with no cap or a workflow run; an ended run is `409 not_continuable`.
- **Where the cap is kept:** the run's serve.json keeps the new cap, with each raise in `cap_raised`. The run's next process opens under it, and so does a server started again.
- **A run paused at its cap goes on.** Once its process has been let go, the server sends it one follow-up turn, "The cap was raised to $X; continue the task.". That turn runs under the new cap, and the answer is `{resumed: true, message_id}`.
- **A working run's live process** keeps the cap it was opened with until its next process, and the answer's `note` says so.
- **If the follow-up does not go**, the run waits for a message (`input_required`, `idle`) and takes one under the new cap.
