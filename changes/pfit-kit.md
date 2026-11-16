---
packages: @parcha/agentrun-computer
kind: feature
---
The conformance kit tells a vendor more before and after its provider is written: the exec pre-check prints what the machine offers, checks stdin while stdout is left unread, and the suite checks that a deleted computer stays gone and, with `--long`, that a quiet computer outlives a vendor's idle timer.
- `--exec-stream` runs one more exec after its checks and prints a block of facts, each with what it means for the provider: whether root's `unshare -n` works (else `unshare -Urn`, the gVisor fence, else no fence for network none, open and allow), whether root can open `/dev/fuse` (Archil), `uname -m` (`facts.arch`), the kernel (gVisor when dmesg says so) and the TCP listeners from `/proc/net/tcp{,6}` (`facts.vendorAgentPorts`). They pass or fail nothing; `--json` carries them as `facts` (and `factsProblem` when the probe could not run).
- A new pre-check, `stdout-unread`, writes 4 MiB to `cat` over 10 s while its stdout is left unread, then reads it: every byte comes back in order, and a write that waits on the reader goes on once stdout is read. An exec whose stdin deadlocks behind a stalled reader fails it in words.
- `provider.create-release` (Core) now also asks for a deleted computer after the refused connect: `attach` by id, a second connect and `list` must all find nothing, so a vendor that wakes a machine on the next request fails it.
- `lifetime.idle` (Full) leaves a computer quiet 6 min, with no call or connection, and reads it still running with its daemon answering. It is a long case: it runs only with the CLI's new `--long` (`long` in `runConformance`'s options), and skips in words without it.
