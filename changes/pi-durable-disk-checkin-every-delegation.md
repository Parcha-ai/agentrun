---
packages: @parcha/pi-durable-disk
kind: fix
---
**On a host that refuses every unmount (Sysbox, as Daytona runs sandboxes), the archil client's own bookkeeping no longer fails the release**
- Deleting any file under an archil mount makes the client list two Active delegations of its own, `<mp>/.archil/client-<n>`
  and `<mp>/.archil/client-<n>/unlinked`. They are outside the run's tree, a checkin of the run leaves them, and a
  checkin of them fails `EROFS` once the mount is read-only.
- The release counted them as the run's. So any run whose app deleted a file failed every release with
  `UNMOUNT_FAILED` ("still lists a delegation after archil checkin"), even after a completed run. Its instance then
  exited failed, and the restarts failed `CLAIM_NOT_VERIFIED` until the box was deleted.
- They no longer count. Every other Active delegation under the mount still holds the run, and the mount is left where
  it is, as before.
