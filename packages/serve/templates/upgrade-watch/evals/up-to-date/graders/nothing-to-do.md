---
type: llm
---
Read the run's answer: its last fenced `json` block. The owner runs v2.5.0 and the newest release is v2.5.0, so there
is nothing to upgrade to. The changelog in the prompt describes changes in v2.5.0 and v2.4.0, which the owner already
has.

Pass only when all of these hold:

1. `verdict` is `up_to_date`, and `current_version` and `latest_version` are both v2.5.0.
2. `findings` is empty, and `versions` is empty.
3. The `summary` says the owner is on the newest release and reports no change: the `--port` removal and the export
   default are in releases the owner already runs, and naming either as something to do fails.

Answer pass or fail, and quote what decided it.
