---
packages: @parcha/pi-browser, @parcha/pi-durable-disk
kind: fix
---
`@parcha/pi-browser` takes Stagehand 4.4.0, whose zod (4.6.6) carries the fix for GHSA-mrhx-c7xc-m3w5, and `@parcha/pi-durable-disk` takes disk 1.12.0, whose undici (^8.12.3) carries the fixes for the October undici advisories. A fresh install of these packages no longer holds either vulnerable copy.
