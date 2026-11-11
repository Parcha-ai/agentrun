---
packages: @parcha/agentrun-computer
kind: fix
---
`process.wait` now returns only once the last of what the program wrote before it exited is in its log file and its streams. Until now the wait could come while a pipe still held up to a pipe buffer of the program's last output, so a log read or stat right after the wait could come up short (the Docker desktop conformance case `process.log` saw 16733125 of 16777216 bytes). A process left in the group that keeps a stream open doesn't hold the wait: computerd waits for the bytes already in the stream when the program exited, never for what the leftover writes later.
