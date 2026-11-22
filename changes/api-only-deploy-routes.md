---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) takes a deploy from the backend in front of it, with the server's token: a template's apply (a redeploy with `agent_id`), the agent's read, its revisions, a rollback (`POST /agents/{id}/current`), and its archive (which its delete needs first) and unarchive. Every other agent, template, trigger, hook and settings route stays refused.

With the launch hook set, the apply makes the package's schedule and feed triggers, and every firing that starts a run goes to the backend, which starts it through the API with the keys and budget it sends. That includes the firings of a trigger the agent had before the profile. The unarchive turns the triggers on again.

Without the hook, the apply makes neither (`not_set_up_here`). A trigger the agent already had stays as it was: an enabled one still fires here and starts its runs on this server's keys. Archive the agent to turn it off.

A webhook, GitHub, Composio or email trigger is never made there (`not_an_option`). Each skipped trigger is a warning under `warnings` (`triggers.<i>`), and the dry run plans it as `skip` in the same words.
