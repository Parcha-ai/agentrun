---
packages: @parcha/agentrun-serve
kind: fix
---
A run paused at its cap and raised goes on the way the API says, on the runner.
- The raise's answer names the follow-up turn (`message_id`): the id the runner sends "The cap was raised to $X; continue the task." under, one per pause, so two raises sent at once, or a retry, name the same message.
- That follow-up shows in the Timeline as the server's row ("AgentRun: The cap was raised to $X; continue the task."), never as the person's "You: …", on pi. (A CLI harness's run records it with its per-request follow-up record, which comes separately.)
- A retry of a raise once the run has paused again under the raised cap is no raise of the new pause: it answers `resumed: false`, and the run stays paused.
