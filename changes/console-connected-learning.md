---
packages: @parcha/agentrun-serve
kind: feature
---
The console calls its agent list Connected agents and adds Agent Dojo as a shared view of the local server's learning results, using the hosted console's dojo gate icon in navigation and the page header. It links retained notes, learned skills, workflow drafts, pending reviews and recent changes to the existing agent Learning tab and source runs, with explicit unavailable or incomplete data states.

Run pages show the full learning result, including grader decisions, validation problems, seed and merge revisions and reported grading usage. Learning data refreshes after returning from a coding-agent handoff and while the page is visible, preserving open edits and reviews. Imported session history is not presented as live learning, and the separate learning SDK's reports are not inferred from it.

When a run keeps some proposals and rejects others, its learning result makes that partial decision explicit while preserving each item's approval status and validation findings.
