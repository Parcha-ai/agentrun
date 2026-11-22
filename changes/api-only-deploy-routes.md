---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) takes a deploy from the backend in front of it, with the server's token: a template's apply (a redeploy with `agent_id`), the agent's read, its revisions, a rollback (`POST /agents/{id}/current`), and its archive (which its delete needs first) and unarchive. The apply makes no trigger of any source, so every run there starts through the backend's API calls, on its keys and budget: each trigger is a warning under `warnings` (`triggers.<i>`, `not_an_option`), and the dry run plans each as `skip` in the same words. Every other agent, template, trigger, hook and settings route stays refused.
