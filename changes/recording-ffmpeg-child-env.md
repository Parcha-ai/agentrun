---
packages: @parcha/agentrun-serve
kind: fix
---
A run's screen recording's ffmpeg now starts with only PATH, the locale and TMPDIR, as the server's other helper programs do. Before, it got the server's whole environment, so a key the server held, under any name, reached it.
