---
packages: @parcha/agentrun-serve
kind: feature
---

Add Learning Dojo to inspect retained knowledge and reviews across agents, and show each run's recorded learning outcome and grader decisions. Refresh learning safely without replacing in-progress edits, confirmations, or paginated results. Keep workflow agents with reserved ids addressable from Dojo, and distinguish approved remote-history uploads from maintenance of a local store. Show workflow draft errors alongside recorded validation problems, including runs with no parsed reflection result.
Manual refresh replies preserve a note opened for editing while the read was pending; a completed write still refreshes its own note list.
Keep the last successful learning snapshot visible during Dojo refreshes and transient failures, with explicit last-read counts instead of misleading current minimums. Refresh agent metadata, discard removed or unsupported histories, and replace cached learning after a successful read.
