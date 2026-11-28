---
packages: @parcha/agentrun-serve
kind: feature
---
An API-only server (`AGENTRUN_API_ONLY=1`) with the launch hook set now makes a template's webhook triggers, as it makes its schedules and feeds. A signed request to the trigger's own hook (`POST /v2/hooks/{trigger_id}`, no token) fires it, and the firing goes to the backend behind the launch hook, which starts the run through the API on its own keys and budget. The hook is served only with the launch hook set and only for a webhook trigger whose firings start a run; GitHub's hook is answered as one that names no trigger, and a path under a hook stays `404`. An apply in a workspace (`AgentRun-Workspace`) makes no webhook trigger yet and says so (`not_an_option`), since no token is shown its signing secret. Without the launch hook a webhook is skipped as a schedule is (`not_set_up_here`).
