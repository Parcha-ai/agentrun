---
packages: @parcha/pi-git-remote
kind: docs
---
The README's coding-agent walkthrough says what it needs before it starts (pi on the `PATH`, and a model, given one of three ways: `/login`, a provider key in the environment, or `~/.pi/agent/models.json`; without one pi stops at "No API key found for the selected model"), seeds the example repository with its own commit identity, so it works where git has no identity configured and cannot guess one, and runs pi once with `-p`, so the session's commit is on its branch when the command returns; the interactive way is one sentence below it.
