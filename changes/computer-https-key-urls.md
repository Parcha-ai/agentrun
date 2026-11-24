---
packages: @parcha/agentrun-computer
kind: fix
---
smol cloud, the phone harness, boxd and Modal refuse an API URL that is not https, loopback included, so the key never crosses in the clear. Agent37, Morph, Orgo and the Cloudflare relay take theirs through the same rule, and say so in its words: "the Agent37 API URL must be https", where they used to say "apiUrl must be an https URL".
