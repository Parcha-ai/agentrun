---
packages: @parcha/pi-durable-disk
kind: fix
---
A dead FUSE mount caught while its daemon's connection is being torn down now reads as dead. Right after a `kill -9` of the daemon, the stat that decides "dead" can be in flight, and the kernel ends it with `ECONNABORTED`; only a stat issued after the teardown gets `ENOTCONN`. `unmountClaim` (and so `release` and the takeover paths) and the local host driver's `stop` counted only `ENOTCONN`, so such a mount read as live: `UNMOUNT_FAILED`, or a dead mount left behind. Both now read either code as dead and clean the mount with `fusermount -u`; any other stat error still reads as live, and a live mount is still never forced.
- The local host driver decided "dead" by matching the English text "Transport endpoint is not connected" in `stat`'s stderr, which coreutils translates, so under any other locale a dead mount read as live. It now runs the stat in a child that prints the errno code, and the check reads that code (`DEAD_CONNECTION`, exported from the claim module); messages are never read.
