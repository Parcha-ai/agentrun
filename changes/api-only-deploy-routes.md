---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) takes a deploy from the backend in front of it, with the server's token: a template's apply (a redeploy with `agent_id`), the agent's read, its revisions, a rollback (`POST /agents/{id}/current`), and its archive (which its delete needs first) and unarchive, which turns its schedule and feed triggers on again since the profile serves no trigger route. The apply makes only the triggers that fire on the server's own clock (a schedule, a feed). A webhook, GitHub, Composio or email trigger needs a hook or a setting the profile refuses, so it is not made, and the answer says so under `warnings` (`triggers.<i>`, `not_an_option`). Every other agent, template, trigger, hook and settings route stays refused.
