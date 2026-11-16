---
packages: @parcha/agentrun-computer
kind: feature
---
Three more vendor exec shapes reach `framedExec` with no code of the vendor's own beyond its calls, each passing the exec pre-check over a fake vendor in the tests.
- Output as server-sent events (Together, Runloop): `sse` in `hosted/rest.ts` reads a `text/event-stream` body as the HTML standard says, beside `ndjson`, which moves there from `hosted/framed-exec.ts`.
- One terminal (DigitalOcean's console, OpenSandbox's PTY socket): `ptyPieces` in `hosted/pty-exec.ts` sets the terminal raw with no echo, runs the process on fifos off it, and carries its stdout, stderr, exit code and stdin as base64 lines; it passes on a real pty.
- No call that writes to a running process (Render): `fifoStdin` in `hosted/framed-exec.ts` starts the process reading a fifo, and each write is one more short exec into it.
