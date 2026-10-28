---
packages: @parcha/pi-durable-disk
kind: fix
---
**The archil wrapper runs archil as root only in the shapes the claim uses**
- `bin/archil-scoped` used to pass every verb except `mount` straight to archil, and checked neither `mount`'s mountpoint nor its flags, so a sudoers rule for the wrapper granted more than the claim needs. It now runs archil only as `mount [--force] <disk>:/<path> <root>/runs/<run> --region <region>`, `unmount`, `checkin` and `delegations --json` of a fuse.archil mount listed at `<root>/runs/<run>`, and its cleanup verbs (`retire`, `stray`, `stale`), each with exact arguments, and rebuilds the argv it hands archil from the checked parts.
- It refuses anything else with exit 2 before archil runs: an unknown verb, an extra, missing or reordered flag, a mountpoint outside `<root>/runs/<run>` or reached through a link, a disk or region that is not one safe token, a path with a `.` or `..` segment, and any argument holding a newline. A host that called the wrapper for any other archil command must call archil directly.
- The reference's sudoers drop-in is unchanged (the wrapper, and `fusermount -u <mountRoot>/runs/*`); it now says never to grant a bare `fusermount`, `mkdir` or `rmdir`, since the run user owns `<mountRoot>/runs`.
