---
packages: @parcha/agentrun-computer
kind: fix
---
A phone's screenshot and its live view's frames no longer stall the server. The phone harness answers in the server's process, and it deflated each screen into a PNG synchronously, about 170 ms for a 1080x2400 screen, once a second while someone watched. Every request and open store transaction waited on it. `encodePng` now deflates on zlib's thread pool and returns a promise, and a live-view frame is published only once it is encoded.
