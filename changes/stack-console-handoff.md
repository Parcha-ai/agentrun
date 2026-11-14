---
packages: @parcha/agentrun-serve
kind: feature
---

Build agents from a brief or the full template catalog using a remembered coding-agent dropdown or the API playground. Handoffs preserve complete template settings and prepared requests, and the server serves its matching setup skill. Imported GitHub templates retain their full package identity and reviewed commit across configuration, prompts and prepared requests, alongside publisher trust, pinned installation and visible provenance.
Setup, build, edit and run prompts read that skill from the selected server, so its instructions match the deployed build.

Template handoffs retain the owner-selected MCP server for each source and toolkit, including prepared API requests. Unread or ambiguous accounts wait for selection; a removed prepared account requires a fresh request instead of switching accounts. Agent edits preserve explicit model and tool-setting resets when switching between JSON and Form before saving.

Keep unfinished Playground requests, selected options, uploaded attachments and displayed responses when setup import refreshes the agent list, including a failed refresh that can be retried. Replacing the authenticated client resets cached console state immediately; signing out also discards the previous session's request. A selected agent removed or archived during refresh requires a fresh choice.
Template handoffs use the server's compiled parameter schema and shared input fields, retaining false, zero, scalar arrays, defaults and reviewed consent while rejecting unknown or lossy prepared values.
