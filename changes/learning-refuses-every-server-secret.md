---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a runner never learns a secret the server keeps. Its end-of-run learning refused only the runner's own secrets, the keys its claim handed it and its sign-in pointers, so a note quoting an MCP server's header or OAuth token, a trigger's settings (a webhook trigger's signing secret, the GitHub App's key and webhook secret), a saved key the run was not handed, a viewer token, the API token or the session secret could be kept. It now refuses every secret the server keeps sealed as well, the list the run's redactor already holds, and the seed notes a learning run is laid are cut of the same list. A run whose server secrets can't be read learns nothing, and says so.
