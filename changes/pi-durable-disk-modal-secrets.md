---
packages: @parcha/pi-durable-disk
kind: feature
---
A key the agent needs on a `modalHost` box reaches the instance from a Modal Secret, by name, and is never written to a file. `secrets: ["<name>", ...]` (`modalHost`, `modalSandboxes`) puts Modal Secrets on every command the driver runs in the sandbox; a string is a Secret's name, looked up once with `sdk.secrets.fromName`, and anything else is an SDK Secret passed as is. `inheritEnv: ["ANTHROPIC_API_KEY", ...]` (`daytonaHost`, so `modalHost` too) names the variables the instance takes from that environment. The launcher's start is told the names and hands the values to the instance in memory: no spec, state, log, argument or handle on the box holds a value, and none passes through the supervisor. A name missing there fails the start, naming it.
