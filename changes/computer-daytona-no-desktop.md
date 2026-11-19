---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
Daytona no longer offers a desktop on any connect (none ever started: its sandboxes block the tool user's namespaces); `{ kind: "desktop", provider: "daytona" }` is refused with the reason. A descriptor may name the setting kinds it doesn't serve and why (`unserved`).
