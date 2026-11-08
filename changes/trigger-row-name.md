---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A trigger's Timeline row names its source and its trigger: "Schedule utc-check: Tell me the time in UTC." where it read "Trigger trg_…: …". pi-durable-agent labels the row by its source (`TRIGGER_LABELS`: Schedule, Webhook, Slack, GitHub) and keeps `trigger: {id, source, owner}`; serve names the trigger as it is now on every page, the stream and the final rows, and by its id once the trigger is deleted. A trigger renamed renames its runs' rows: the name it had when it fired is not kept yet, and comes when the message that fires a run carries its trigger's name.
