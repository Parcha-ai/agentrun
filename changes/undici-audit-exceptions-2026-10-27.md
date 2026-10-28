---
packages: repo
kind: ci
---
**The package check accepts five more undici advisories on the copies the disk SDK and pi-coding-agent pin, until 2026-11-06**
- The disk SDK (1.10.0) and @earendil-works/pi-coding-agent (1.4.0) still pin undici 8.10.2 exactly. Five advisories published by 2026-10-27 are fixed only in 8.12.2: GHSA-4w7w-5xrc-9h26, GHSA-2m5v-pch6-74hx and GHSA-qrxm-fqhp-jwvm (high), and GHSA-9fm3-97px-rjf6 and GHSA-55wc-3pg8-jfw6 (moderate). The existing undici exception now names them. It keeps the same two parents and the same 2026-11-06 expiry, and any other advisory, any copy elsewhere, or a date past the expiry still fails the check.
