---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
Daytona no longer offers a desktop, on any connect: `DAYTONA.capabilities` has no desktop configuration, `new DaytonaProvider({ kind: "desktop" })` throws on dial as on exec, and a run whose computer is `{ kind: "desktop", provider: "daytona" }` is refused with the reason, never moved to another provider. It never worked: Daytona's sandboxes run under AppArmor's `restrict_unprivileged_userns`, so the tool user can't make the user and network namespaces the window manager runs in, and every Daytona desktop failed at its start. Pick a desktop on Docker, Modal, E2B, Agent37, Cloudflare, Fly Machines, Orgo or boxd, or keep Daytona for a sandbox. A provider descriptor may now name the setting kinds it doesn't serve and why (`unserved`), and serve says those words when it refuses one.
