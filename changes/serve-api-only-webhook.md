---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) with the launch hook set now serves a webhook trigger's own hook. A signed request to `POST /v2/hooks/{trigger_id}` (no token) fires it, and the firing goes to the backend behind the launch hook, which starts the run through the API on its own keys and budget. The hook is served only with the launch hook set and only for a webhook trigger whose firings start a run; GitHub's hook is answered as one that names no trigger, and a path under a hook stays `404`. A template apply still makes no webhook trigger, in a workspace or not, since its answer shows no signing secret: it is skipped with `not_an_option`, in words that say to make it with `POST /v2/triggers` in a workspace (`AgentRun-Workspace`), whose first answer shows the secret once.
