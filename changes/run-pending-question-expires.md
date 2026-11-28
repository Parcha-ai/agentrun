---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
A waiting run's question (`pending.kind` `question`) may now say when it expires unanswered: `expires_at`, an RFC 3339 UTC time, as the browser and computer asks already do. It is optional and additive. A backend that sets the question a deadline fills it; the local server sets none and leaves it out, so a question read there is unchanged. The TypeScript and Python clients' and the console's run types carry the optional field.
