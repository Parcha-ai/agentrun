---
packages: @parcha/agentrun-serve
kind: fix
---
A run's fal jobs no longer collide with another run's: fal's hosted MCP server (`mcp.fal.ai`) keeps one `submission_key` journal per fal account and refuses a key it has seen with another request, so the same task run twice in a day, which makes the same keys, had its second run refused. The run's gateway now sends fal each `submission_key` of `run_model`, `submit_job`, each request of `submit_jobs` and `get_submission` with a suffix derived from the run, so a retry within one run still reaches fal with the same key and is deduped, and two runs never share one. Replies read back with the agent's own key. A key too long for fal's 128-character limit with the suffix is shortened with a hash of the whole key, never cut into another key. A server saved with the toolkit `fal` at another address (an eval's fake) receives the agent's keys unchanged.
