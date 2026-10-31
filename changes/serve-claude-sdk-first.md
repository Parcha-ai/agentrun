---
packages: @parcha/agentrun-serve
kind: fix
---
When claude-agent can't run here, its reason now names the missing Claude Agent SDK, with its install line, before any missing key. A server with no SDK and no `ANTHROPIC_API_KEY` used to say only that the key was missing. Setting the key would then not have made claude-agent available, and the image's smoke check failed on that reason. The key is still named once the SDK is in place.
