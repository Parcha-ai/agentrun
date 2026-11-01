---
packages: @parcha/pi-durable-disk
kind: fix
---
A run's command records now carry the pid namespace that wrote them and the write's time in clock ticks since boot. An open in another pid namespace (a restarted container, or a reader in a box) no longer takes the records' processes for gone just because it can't see them:
- A record of another boot is forgotten.
- A record of this boot, written before the reader's PID 1 started, is forgotten: it is a previous incarnation's.
- Anything else is kept. Nothing it names is signalled, and the open is refused (`HeldError("commands")`, exit 76) with the files named.

The rule holds while serve's data root is never shown to a box, one server holds a data root at a time, and serve is the child of its namespace's PID 1 (tini, as the image's ENTRYPOINT starts it), so its namespace ends when it exits. Records written before this change are read as before.

Each open now records the box its run runs in as `run.json`'s `box.mode` (`bwrap`, `seatbelt`, `provider`, `unsandboxed` or `unavailable`), exactly as the host gives it through `boxMode`, or `--box-mode` on `pi-durable-disk run`. It is never probed. The next open reads a switch of box from the record. Whatever the switch, the commands reap runs on the host before anything of the new incarnation, so a boxed open after an unboxed one is held while that incarnation's command lives. An open given no box records none.

An open given an `unavailable` box is refused by name: `BoxUnavailableError`, `BOX_UNAVAILABLE`, exit 78. No open can run without a box, so a launch that carries this mode is a host error. The refusal comes before the claim is taken, from `openDurableRun` and from the CLI before it starts anything. Nothing of the run is written, and the next open with a box proceeds.
