---
packages: @parcha/pi-durable-disk
kind: fix
---
**On a host that refuses every unmount (Sysbox, as Daytona runs sandboxes), release checks in each delegation the client still lists under the mount**
- The release checked in the mountpoint and then required the client to list no Active delegation under it. A
  delegation the client still held on a path under the mount (a file under `record/` on a box) failed the release with
  `UNMOUNT_FAILED` ("still lists a delegation after archil checkin"). The instance then exited failed, and its restarts
  failed `CLAIM_NOT_VERIFIED` until the box was deleted.
- Now each path still listed is checked in by its own path and the list read again, up to three passes, 200 ms apart.
  The release fails only when a delegation is still listed after that, and the mount is then left where it is, as
  before.
