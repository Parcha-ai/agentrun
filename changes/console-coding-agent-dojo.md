---
packages: @parcha/agentrun-serve
kind: feature
---
Mission Control shows agents, imported sessions and analytics before the first server-run agent, without requiring a model-provider key. First-use guidance is dismissible; execution setup remains available in Settings and the playground.

Import agents is available from Mission Control and Agents through a remembered coding-agent selector, with separate app and CLI choices. Build, edit, run, query and playground actions use the same control. Prompts target the current server and its OSS skill/MCP/API; importing verifies the destination store and explains the local-to-remote boundary. History import does not connect live external sessions. CLI handoffs copy the prompt, supported app choices open a prefilled prompt, and blocked clipboard access offers selectable text instead of downloading a file.

The OSS console follows the hosted console's navigation and layouts while using the local server's `/v2` API. Agents has Build, Connected agents and Runs submenus; Mission Control and run history have compact toolbars and consistent panels.

Build opens a description composer with local starter templates. Build, edit and run actions offer the remembered coding-agent selector and API playground. Templates preserve their full definition in both destinations without automatically creating or running an agent. The playground now supports creating definitions and saving revisions, preserves unrelated settings, and checks revision ETags when editing. An uncertain creation response requires checking the agent list before retrying.

Agent pages show configuration and live-job links beside a runs table, version history and supported workflow, learning and analytics tabs. Returning from a coding-agent handoff refreshes both the definition and loaded runs.

Query actions open read-only run requests in the playground, retaining the agent, status and archive filters with scoped pagination.

The console calls its agent list Connected agents and adds Learning Dojo as a shared view of the local server's learning results, using the hosted console's dojo gate icon in navigation and the page header. It links retained notes, learned skills, workflow drafts, pending reviews and recent changes to the existing agent Learning tab and source runs, with explicit unavailable or incomplete data states.

Run pages show the full learning result, including grader decisions, validation problems, seed and merge revisions and reported grading usage. Learning data refreshes after returning from a coding-agent handoff and while the page is visible, preserving open edits and reviews. Imported session history is not presented as live learning, and learning reports are not inferred from it.

When a run keeps some proposals and rejects others, its learning result makes that partial decision explicit while preserving each item's approval status and validation findings.
