---
packages: @parcha/agentrun-serve
kind: feature
---
A schedule tells you when it misses or fails. Of the times missed while the server was down, the latest still fires, once and marked `catch_up`, when it is within the trigger's `catchup_window_s` (default 3600; 0 never catches up), and the rest stay one `missed` firing with their count.
A firing whose run is refused sends a `trigger.failed` webhook message, signed like the run notices, with `data: {trigger_id, name, firing_key, nominal_at, error, auto_paused}`; its `webhook-id` is made from the firing's key, so a restart never sends it twice. Five failed firings in a row turn the trigger off with `disabled: {reason: "auto_paused"}`, and the fifth's message says so; a firing that starts its run resets `failures_in_a_row`, and so does turning the trigger on again. A webhook receiver now sees this third message type when a trigger fails; capabilities list it in `features.webhooks.events`.
Overlap stays `skip` alone: a firing while the last run is active (working, or parked waiting on a person) is skipped with why, never queued, because a firing queued behind a parked run would wait as long as the person does.
