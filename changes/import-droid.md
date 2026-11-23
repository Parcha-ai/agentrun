---
packages: @parcha/agentrun-import, @parcha/agentrun-serve
kind: feature
---
`@parcha/agentrun-import` reads Factory's Droid CLI, a new source (`droid`): each session's `~/.factory/sessions/<cwd slug>/<id>.jsonl` (some in `sessions/` itself), under `$FACTORY_HOME_OVERRIDE` instead of the home where the environment names it. `normalizeUsage("droid", …)` reads Droid's `tokenUsage`: `inputTokens` already leaves the cache out, and `thinkingTokens`, part of `outputTokens`, is kept as `reasoning`.
- Droid writes no request's tokens to disk. A session's tokens are the running total in the `<id>.settings.json` beside its transcript (`tokenUsage`, its own calls alone), put on its last request, the others 0. A session with no settings file has tokens 0. Droid writes no dollar cost, so `cost` is that total at the catalog's list price for the session's model, `null` for a model the catalog does not list (a BYOK `custom:` model).
- Each assistant message is one request; each record counts once by its `id`, so a fork's copies of its source's records count in the source alone. A Worker, whose `session_start` names its `callingSessionId`, counts under that session, with no turns of the person's.
- serve's import still imports runs from Claude Code, Codex and pi alone (`IMPORT_SOURCES`), the sources its `imported_from` names; Droid sessions count in the package's `parseHome` and its CLI.
