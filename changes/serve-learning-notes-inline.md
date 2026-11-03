---
packages: @parcha/agentrun-serve
kind: feature
---
A run that learns reads its notes whole in its instructions under `# Learned`, so an agent with no `read` tool follows what it learned. Before, `# Learned` held only the index's one line per note, and the notes were files in `.learning/` that such an agent could never open.
- Each active note is there whole (`## name (file.md)`, its description, then its text), the one changed last on `main` first, while they all fit the learning budget: `--learning-budget BYTES` (or `AGENTRUN_SERVE_LEARNING_BUDGET`), 8000 bytes by default. Past it, the run reads the index, then the notes changed last, whole, while they fit; an agent with the `read` tool is told the rest are in `.learning/`, and one without is not. `0` gives the index alone.
- Every name, description, text and index line the run reads is cut of the server's secrets as they are when the run is made, in its instructions and in its copy in `.learning/`.
- A run's pin (`runs/<id>/learning.json`) keeps what it reads as `section`. A pin an earlier server wrote, the index alone as `learned`, is read as that server gave it.
