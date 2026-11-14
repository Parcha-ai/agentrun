---
packages: @parcha/agentrun-serve, repo
kind: feature
---
Preview and explicitly import ended sessions for one source project and runtime, with separate owner and source consent for history-only or combined connections. Transfers redact and bound selected content, preserve stable source identities for deduplication, and lock authorization guards inside each run import transaction so acknowledged revocation or disconnection prevents later writes.
Export the exact approved inventory; changed selections require a fresh preview and consent. Resumed conversations retain their first imported snapshot while later sessions continue importing. Disconnected targets cannot advertise live launch readiness even while their source worker remains online.
Recheck the approved source identity before and after reading each exported session, including archive replacements that preserve file size and modification time.
Read complete opening metadata records when discovering remote sessions, so large valid Claude Code prompts are included; report sessions whose project cannot be checked within the bounded read.
Reject oversized selected transcripts before parsing them during previews and export pages, while still using a bounded metadata probe to identify their project.
