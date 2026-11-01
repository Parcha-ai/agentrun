---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: feature
---
`boxSlot` (`@parcha/agentrun-kernel/host`) runs one session's harness boxes one at a time, whatever the isolation: how a box starts and how it is reaped are its arguments, in the shapes of the kernel's new `Box` (`host/box.ts`: `BoxSpec`, `BoxRecord`, `BoxRecorder`, `BoxedChild`, `Reaped`, `BoxError`).
- `start` is synchronous. It is refused with `BoxError` `box_busy` while the session's last box is live, being reaped, or was not counted empty. The box's start writes its record before the spawn (`ahead`) and before its first process is let go (`started`).
- The box is reaped as soon as its process exits or is never let go. Only the reap's own count frees the slot. The box's exit status and output are never read, since anything in the box can forge them. A box left with processes, or one nothing could count, rejects with `box_not_empty` and keeps the session from starting another. `adopt` reaps the record a session's last box left before anything starts.
- serve's `writeDurableSync` and `writeDurable` sync the new file and its directory before they return. `boxRecorder` writes a run's `box.json` with them, and refuses a record that names no writer, since such a record could never be cleared safely.
- A box that exits while its `started` record is still being written is reaped once that write lands, by the record it wrote. A box that has ended records nothing more, so a late write never replaces the next box's record.
- The durable writes write every byte or fail. A short write (a disk nearly full) is never synced and renamed as a whole record; the recorder refuses it with `box_record_failed` and leaves no part behind.
