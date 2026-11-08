---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
Slack triggers: mention the server's Slack app in a channel to start a run, and reply in the thread to steer it. `PUT /v2/settings/slack` sets the app (its signing secret and bot token, checked with Slack's `auth.test` and kept in the Slack source's sealed settings), and a trigger with `source: {kind: "slack", channels, post_answer?}` owns its channels (`409 scope_taken` for one another trigger lists). Slack is a source in the trigger registry, served by the one push handler at `/v2/hooks/slack`: each request is checked by Slack's v0 signature before anything else, and `url_verification` is answered only after that check. One line is posted in the thread when the run needs its person and when it ends, tried again until Slack takes it.

A pushed source now declares who may start a run and who may steer one (`trust`), and the trigger kernel holds every event to it: a Slack thread opens only by a workspace member's mention, a reply steers its run only from a member, and it may answer the run's question or go on after a stop, never a tool call's approval or a pause at the spend cap. A bot's message starts and steers nothing.

A trigger's Timeline row names its source and its trigger as it is now: "Schedule utc-check: Tell me the time in UTC." where it read "Trigger trg_…: …", and the trigger's id once it is deleted. The name a trigger had when it fired is not kept yet: it comes when the message that fires a run carries it. The sources a trigger origin may name, and the word a row begins with, are a registry (pi-durable-agent `registerTriggerSource`, `triggerSources`, `triggerLabel`), which serve fills from its trigger registry; `TriggerSource` is a registered source's id, a string.
