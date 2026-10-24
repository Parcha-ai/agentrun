---
packages: @parcha/pi-browser
kind: fix
---
Security: pi-browser's own zod moves from ~4.4.3 to ~4.6.6, the release that fixes GHSA-mrhx-c7xc-m3w5 (a high-severity memory exhaustion while validating large arrays). The copy of zod that `@browserbasehq/stagehand` pins for itself (4.4.3 in every Stagehand release so far) is outside pi-browser's control until Stagehand ships a fixed release; the package gate accepts that one nested copy until 2026-11-06.
