---
packages: "@parcha/agentrun-computer"
kind: breaking
---

A hosted vendor's `exec` now has to keep UTF-8 text intact both ways (every code point, long lines, `\r` and `\r\n`, no terminal), where it had to carry every byte value. The daemon's upload through exec, for a host with no `upload`, goes as base64 text through `head -c <length> | base64 -d`, so it needs no end of stdin, and nothing the adapter runs waits for one: a vendor with no end of stdin leaves `end()` doing nothing. `framedExec` (`src/hosted/framed-exec.ts`) builds a `MachineProcess` from a vendor's split calls (start, an event stream as text, NDJSON or base64, a call per write, end and kill optional): it queues the writes in order, decodes output as one stream, and kills by pid when the vendor has no kill. The REST client gains `stream`, a call whose body is read as it comes, bounded on its headers alone. The exec pre-check (`--exec-stream`) checks text: every class of code point, `\r`, `\r\n`, a 1 MiB line and 8 MiB of random UTF-8 by sha256, and never ends stdin.

Breaking: the pre-check's `stdout-bytes` and `stdin-bytes` checks are `stdout-text` and `stdin-text`, `bytesProblem` is `textProblem`, and `runToExit`'s `stdin` is an iterable of pieces, each whole UTF-8 text.
