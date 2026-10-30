---
packages: @parcha/pi-durable-disk
kind: fix
---
A run's command records now carry the pid namespace that wrote them and the write's time in clock ticks since boot. An open in another pid namespace (a restarted container, or a reader in a box) no longer takes the records' processes for gone just because it can't see them:
- A record of another boot is forgotten.
- A record of this boot, written before the reader's PID 1 started, is forgotten: it is a previous incarnation's.
- Anything else is kept. Nothing it names is signalled, and the open is refused (`HeldError("commands")`, exit 76) with the files named.

The rule holds while serve's data root is never shown to a box, one server holds a data root at a time, and the server is its namespace's main process. Records written before this change are read as before.
