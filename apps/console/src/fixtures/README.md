# Recorded fixtures

Responses of AgentRun Server's `agentrun.v2/0`, recorded from the serve package's dev kit (`packages/serve/dev`: the
seed on its scripted model; synthetic content, no key, no network). Each file is `{request, status, headers, body}`
exactly as the server answered. Nothing here is hand-written: re-record instead of editing.

Names: `run.<status>.<state>.<n>` is a run in that status and state, with `.timeline` and `.files` for the same run.
`run.with-files.*` is a run with an output file and that file's bytes. `error.*` are the server's typed errors.

Two recordings on 2026-10-28 from the same seed: one right after a restart (`run.working.idle.1`, `run.queued.working.1`:
runs not yet relaunched) and one 15 seconds later (`run.working.working.*`: the same runs relaunched, a live turn).

`capabilities.json`'s `tools` is a later recording than the rest of that file (2026-11-03, a server on the faux model
with no keys): the console reads a tool only as the object serve sends, and the first recording listed bare names.

`timeline.<shape>.<state>` are one pi run's timeline (`GET /v2/runs/{id}/timeline`) in both of the server's shapes,
recorded by its timeline projector: `actions` one row per action (capabilities' `timeline.actions`: a call's own
`tool_use` row changing in place), `legacy` a call row then its result row. `completed` is the run settled, `working`
the same run live, a write still running. The run reads a missing file, reads three, searches and fetches the web, fails
a write outside its workspace, writes, asks a question, has a write interrupted and retried, and answers.

`error.definition-stale-etag` is a definition PUT with an `If-Match` that is not the current revision (412);
`error.definition-invalid-body` is one whose body is not `{definition, skills?, note?}` (422).

`write.*` are the agent writes, recorded the same way on a scratch copy of the seed: create (201), an edit with the
current `If-Match` (200, new ETag) and one with a stale one (412), the revisions, setting an earlier revision current,
archive and unarchive, an invalid harness (422 with its `fields`), and a run on a harness the server does not run (409
`agent_not_runnable`).

`start.*` are run starts, recorded the same way:
- an agentic run (202, `Location`);
- the same request again with the same `Idempotency-Key` (the same run);
- that key with another body (409 `idempotency_mismatch`);
- a run pinned to an earlier revision;
- a workflow run with its typed input;
- a workflow input its schema refuses (422);
- a start with no key;
- a sandbox agent's run on a box the server does not have (409 `agent_not_runnable` with `details.box`), recorded from a
  server started on the faux model with no box enabled.

`auth.*` are the owner's sign-in routes, recorded on a fresh server with accounts (the CLI's default) as the page meets them (same origin, the session cookie):
- no password yet;
- a password too short (422);
- setting it (201);
- signed in, and a read signed in (200) and without the session (401);
- setting it again (403);
- signing out;
- a wrong password (401), then the right one.

`run.escalated.*` are one workflow run that escalated, recorded from a server with live decision models during a QA pass rather than from the dev kit: a judge found the evidence did not support the claim, and the run completed with `review` (`needs_evidence`, its node and its reason). They are its run (`GET /v2/runs/{id}`) and its graph (`GET /v2/runs/{id}/graph`), the bodies as the server answered.

No password is recorded: a request that sent one lists only its field names (`body_fields`), and the session value is a placeholder.
