---
packages: @parcha/agentrun-serve
kind: feature
---
`PATCH /runs/{run_id}` with `{max_cost_usd}` raises a run's spend cap, and only raises it. The new cap must be above the run's current cap, its last raise included, and the same raise sent again (a retry) changes nothing. It is `422` otherwise, and for a run with no cap or a workflow run; an ended run is `409 not_continuable`.
- **Where the cap is kept:** the run's serve.json keeps the new cap, with each raise in `cap_raised`. The run's next process opens under it, and so does a server started again.
- **A run paused at its cap goes on.** The answer is `{resumed: true, message_id}` at once. Once its process has been let go, the server sends it one follow-up turn, "The cap was raised to $X; continue the task.", under that `message_id`, and the turn runs under the new cap. It is sent once, by a server started again if the first was stopped before it went, and shows in the timeline as a message (`user_message`).
- **A working run's live process** keeps the cap it was opened with until its next process, and the answer's `note` says so.
- **If the follow-up does not go**, the run waits for a message (`input_required`, `idle`) and takes one under the new cap.
