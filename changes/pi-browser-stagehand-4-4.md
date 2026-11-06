---
packages: @parcha/pi-browser
kind: breaking
---
`@parcha/pi-browser` runs on Stagehand 4.4.0, whose zod (4.6.6) carries the fix for GHSA-mrhx-c7xc-m3w5. If you upgrade: a local Chrome must be 137 or later, `cdpProvider({ endpoint, extensionId })` and `AttachTarget.extensionId` are gone (Stagehand finds its extension by name), and `STAGEHAND_TELEMETRY` and `STAGEHAND_INIT_IN_PROGRESS` are no longer exported.
- **One client per browser.** Stagehand 4.4 attaches one client to a browser at a time. Closing a driver now disconnects it, so the next attach (a handoff, a reconnect, a durable reattach) is allowed; an attach while another client holds the browser fails with "A Stagehand client is already connected".
- **One Stagehand extension per browser.** Stagehand refuses a browser with two. The cdp provider uninstalls any other Stagehand extension from a local Chrome at each attach, so the lease's confined copy is the one used. A Chrome you attach to by endpoint must hold at most one.
- **The extension dials the browser directly.** `AttachTarget.extensionCdpUrl` names the browser's own DevTools URL for the extension's connection; the cdp provider sets it for a local Chrome. A dropped connection between the driver and the browser then no longer stalls the next attach for 60 s.
- **No trace export.** Stagehand 4.4 exports traces only to an endpoint it is given, and the driver gives none. The closed loopback trace port, and the request observer's exemption for it, are gone.
- **Shutdown with no drain.** `handle.close()` of the pi-durable adapter, with no `drain` before it, now waits (30 s at most) for this process's `close` releases to reach the provider. Before, a host that closed the Harness straight after them left the browser running whenever the driver closed fast enough, which Stagehand 4.4's does.
