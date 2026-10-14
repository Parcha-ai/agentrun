---
packages: @parcha/pi-durable-disk
kind: feature
---
**`localRun(root)`: a run on a plain local directory, one machine**
- New export `localRun(root)` returns `openDurableRun`'s `acquire` and `claimDir` for a run in a directory of this
  machine: the claim is the directory (made when missing), with no mount; `claimDir` is `openClaimDir(root, { fstype:
  null })`. Its barrier refuses once fenced and syncs nothing (SQLite makes the store's commits durable; `work/` is the
  OS's to flush). It is for one machine and says so: only the owner lock keeps a second process off the run.
- `mountToken` is optional: required only with the default `acquire` (refused with `INVALID_ARGUMENT` before anything
  mounts when missing); a replaced `acquire` is handed an empty token.
- A local run needs Linux, for now, and the README says why: the run's root is held open through `/proc/self/fd`
  (`openClaimDir`), and the default environment needs `setpriv` (`noNewPrivs`) and `/proc/self/fd` (`confineFiles`).
  macOS has neither.
