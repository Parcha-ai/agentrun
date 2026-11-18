---
packages: @parcha/agentrun-serve
kind: feature
---
Run Particle-1 directly on Pi with `particle/particle-1` and `PARTICLE_API_KEY`, available in Settings → Model keys
and the model picker. Keys use provider-scoped custody. Native streaming tools, reasoning continuation and cache
affinity travel through Pi's local proxy; existing OpenRouter support and its text-tools workaround remain separate.

Token accounting distinguishes cached input and includes reasoning in output once. Costs use regular peak list-price
estimates, not Particle's account bill. Missing or malformed usage fails with unknown cost; cancellation and errors
do not silently resend a paid request. Pi claims with a Particle route disable automatic conversation retries,
including mixed-provider claims with a Particle subagent tier.

The direct route supports Pi, workflow model nodes (including nested learned workflows) and grades. Side calls inherit
the live port's model metadata; calls with no conversation ID use route-local cache affinity. HTTP Responses gateways
and CLI harnesses are unsupported; configuring Particle as `AGENT_MODEL_BASE_URL` is refused with setup instructions.
Live validation requires a key and explicit spend authorization; see the server README's Direct Particle-1 section.

The Compose files (`compose.yaml`, `deploy/compose.yaml`) pass `PARTICLE_API_KEY` through to the server.
