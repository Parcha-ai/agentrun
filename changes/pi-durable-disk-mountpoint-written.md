---
packages: @parcha/pi-durable-disk
kind: fix
---
**A start whose own writes are in the bare mountpoint is refused, `MOUNTPOINT_WRITTEN`, instead of losing them**
- The CLI calls an app's factory before its claim mounts. A factory that wrote under `ctx.root` (a recorder, a `signals/`
  directory) wrote into the bare mountpoint. Acquire then moved those entries aside as an earlier incarnation's
  leftovers, the mount hid the rest, and the run later failed `ENOENT` on files it had written itself. Every pre-mount
  write was lost without a word.
- Acquire now tells the two apart by time. Entries written since this process started are its own, so the start is
  refused: `ClaimError` `MOUNTPOINT_WRITTEN`, exit 65 (terminal, since a restart would write them again). The message
  names the first few as `<mp>/...` in at most 240 characters. Nothing moves aside and nothing mounts. Older leftovers
  are moved aside as before, logged by count only.
- `ClaimError` takes an `exitCode`.
