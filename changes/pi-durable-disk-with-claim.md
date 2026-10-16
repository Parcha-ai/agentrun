---
packages: @parcha/pi-durable-disk
kind: feature
---
**`withClaim` and `readReleased`: a short exclusive claim on any path of a disk, and a consistent S3 read of what it
released**
- `withClaim({ control, disk, region, path }, fn, options)` holds `path` exclusively while `fn` runs (pi-durable-agent's
  carry back of `agent/agent.sqlite` at a run's end). It mounts at a fresh `<mountRoot>/runs/<pid>-<uuid>`, writes `.claim`
  with its deadline (`holdMs`, 60 s), runs `fn`, then barriers, unmounts and gives its mount token back, also when `fn`
  throws.
  - A lost holder is revoked before the mount: orphaned, or holding exactly the path with an expired `.claim` that stays
    the same for 3 s. A live one within its deadline is waited for (`waitMs`, 30 s), never revoked. An abort of
    `signal` before the mount runs nothing.
  - It makes the path's directories the disk lacks (owned by the calling process, 0700, or `owner`): archil mounts no
    path whose directory is missing.
  - It refuses `INVALID_ARGUMENT` for an unsafe path or one under `runs/` or `.archil/`, `CLAIM_HELD` (76) for a live
    holder after `waitMs`, and `CONTROL_API_FAILED`. It is `FENCED` (75) when revoked from under `fn`, whose writes are
    then not durable.
- `readReleased({ control, path }, file, { sqlite })` reads a released file over S3, with no mount: no delegation before
  or after, the object unchanged across the read, and for SQLite no `-wal` with content (`NOT_RELEASED`). It returns
  `null` when the file does not exist.
- `CLAIM_HELD` from either is retryable: the path is not released yet. Retry within `waitMs`, and never fall back to an
  older release.
