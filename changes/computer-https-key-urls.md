---
packages: @parcha/agentrun-computer
kind: fix
---
Agent37, Morph, Orgo and the Cloudflare relay take their API URL through the shared https rule, and say so in its words: "the Agent37 API URL must be https", where they used to say "apiUrl must be an https URL".
