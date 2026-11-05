---
packages: @parcha/agentrun-serve
kind: feature
---
The OSS console follows the hosted console's navigation and layouts while using the local server's `/v2` API. Agents has Build, Connected agents and Runs submenus; Mission Control and run history have compact toolbars and rounded cards.

Build opens a description composer with local starter templates. Build, edit and run actions offer the remembered coding-agent selector and API playground. Templates preserve their full definition in both destinations without automatically creating or running an agent. The playground now supports creating definitions and saving revisions, preserves unrelated settings, and checks revision ETags when editing. An uncertain creation response requires checking the agent list before retrying.

Agent pages show configuration and live-job links beside a runs table, version history and supported workflow, learning and analytics tabs. Returning from a coding-agent handoff refreshes both the definition and loaded runs.

Query actions open read-only run requests in the playground, retaining the agent, status and archive filters with scoped pagination.
