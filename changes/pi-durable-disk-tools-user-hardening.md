---
packages: @parcha/pi-durable-disk
kind: breaking
---
A run's archil mount is `nosuid,nodev`, and `run --run-as` refuses what the agent's commands could use against the root instance. Who breaks: an image whose `bin/archil-scoped` predates this release (install the new one: a run on its unhardened mount is now refused with `MOUNT_FAILED`), a `--run-as` in group root, and an `--app` that is not root's under `--run-as`. What to do: install the new wrapper, run the tools as a user outside group root, and keep the app root's (`chown -R root:root`, no group or other write).
- `archil-scoped mount` bind-remounts exactly the mountpoint `nosuid,nodev` after archil mounts it (archil takes no mount options; its mounts were `rw,relatime`), exits 9 when archil listed no mount there or the remount fails, and takes only the claim's mount line, `[--force] <source> <mountpoint> [--region <region>]`. `acquire` refuses and unmounts a mount without `nosuid,nodev`.
- `run --run-as` refuses a gid of 0, an `--app` (or a directory on its path) that is not root's or is writable by its group or others, or one inside the run's root; and, when transport's launcher verified a tools user (`PI_TRANSPORT_TOOLS_USER`/`PI_TRANSPORT_TOOLS_UID`), any `--run-as` but that uid, or none.
- The instance closes the launcher's secrets descriptor and drops `PI_TRANSPORT_SECRETS_FD` before anything runs.
