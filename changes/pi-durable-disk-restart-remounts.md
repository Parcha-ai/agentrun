---
packages: @parcha/pi-durable-disk
kind: fix
---
**A restart whose mount went with the failed incarnation mounts again on Daytona, and fails at once and clearly everywhere else**
- `daytonaHost`'s launcher handed the attempt's mount token to the first incarnation only, so a restart could only reuse a
  live mount. When the failed incarnation's release had already let the mount go (always on Sysbox, where it is moved
  aside), every restart had no token and no mount. Each one then failed with archil's misleading "Authentication failed",
  until the launcher's restart limit, and the run never recovered. Every incarnation of an attempt now gets the token:
  such a restart mounts again, and after a takeover that mount is `HeldError` (76, terminal), as before.
- Everywhere, an incarnation given no mount token (`--token-stdin` read nothing) that finds no live mount to reuse is now
  fenced at once, before any mount: `FencedError` `CLAIM_GONE_NO_TOKEN`, exit 75, terminal. It no longer loops on a mount
  that cannot succeed, and the supervisor's next start brings a new token. `localHost` keeps handing its token to the
  first incarnation only.
