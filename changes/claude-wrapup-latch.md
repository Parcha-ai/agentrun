---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A capped run is told to wrap up when it is really near its cap, and Claude Code, Codex and OpenCode runs are told as pi runs are. Step 0 (nothing priced yet) is judged on the request taking the note itself, its input and a 4,096-token answer, and told in that request, as pi's is. A CLI run used to judge it at a request's admission, after that request's note was taken, and kept the judgement after the first real cost came in, so a run spending about a cent a request could hear "finish now" from its second request on. From the first priced request on, the run's measured typical request cost decides. On every harness, a run is also told once what is left falls under twice the least admission of the request taking the note, the figure the cap refuses it below, so a run whose requests need far more output than they cost is warned before the cap stops it.

Upgrading: the kernel's model port and model proxy note hooks (`ModelPort.note`, `ModelProxyHooks.note`) take a second argument, the request about to take the note as its client sent it (`NoteRequest`: its input bound and output asks). The model proxy measures the request before it asks for the note. A host that implements the hook may ignore the argument.
