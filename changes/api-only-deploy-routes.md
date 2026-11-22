---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) takes a deploy from the backend in front of it, with the server's token: a template's apply (a redeploy with `agent_id`), the agent's read, its revisions, a rollback (`POST /agents/{id}/current`), and its archive (which its delete needs first) and unarchive. Every run there starts through the backend, on its keys and budget: with the launch hook set, the apply makes the package's schedule and feed triggers and each firing goes to the backend, which starts the run through the API (the unarchive turns them on again); without the hook it makes neither (`not_set_up_here`). A webhook, GitHub, Composio or email trigger is never made there (`not_an_option`). Each skipped trigger is a warning under `warnings` (`triggers.<i>`), and the dry run plans it as `skip` in the same words. Every other agent, template, trigger, hook and settings route stays refused.
