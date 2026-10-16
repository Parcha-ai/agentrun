---
packages: @parcha/pi-durable-agent
kind: feature
---
`EXPORTABLE_KINDS`, `SECRET_KINDS` and `projectForExport(kind, value)`: what an exporter may copy out of an agent home. The exporter copies only the four listed kinds (`agent.identity`, `agent.definition`, `agent.skills`, `agent.runs`) and drops every other kind, an unknown one included; `projectForExport` returns a deep copy, with the caller's `host` removed from an `agent.runs` record, or `undefined` to drop the document. Saved sign-ins, save leases, and each host's aliases and tool bindings are on `SECRET_KINDS` and never leave the home. A test fails on any kind the package defines that is on neither list.
