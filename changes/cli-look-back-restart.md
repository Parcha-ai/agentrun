---
packages: @parcha/agentrun-serve
kind: fix
---
A learning run on a CLI harness (claude-agent, codex, opencode) whose runner died or lost its claim during the end-of-run look-back no longer pays for that look-back twice on the next claim. The next claim settled nothing: it resumed the open look-back as if it were the job's turn, threw its answer away, and then asked the CLI again. Now the open look-back is settled and asked again once, under the run's cap, and a request the earlier attempt sent is booked once at an unknown price. The run's learning also keeps the job's cost and answer time from the first attempt, so the earlier attempt's spend counts as look-back spend instead of job spend.
