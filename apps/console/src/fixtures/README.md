# Recorded fixtures

Responses of AgentRun Server's `agentrun.v2/0`, recorded from the serve package's dev kit (`packages/serve/dev`: the
seed on its scripted model; synthetic content, no key, no network). Each file is `{request, status, headers, body}`
exactly as the server answered. Nothing here is hand-written: re-record instead of editing.

Names: `run.<status>.<state>.<n>` is a run in that status and state, with `.timeline` and `.files` for the same run.
`run.with-files.*` is a run with an output file and that file's bytes. `error.*` are the server's typed errors.

Two recordings on 2026-10-28 from the same seed: one right after a restart (`run.working.idle.1`, `run.queued.working.1`:
runs not yet relaunched) and one 15 seconds later (`run.working.working.*`: the same runs relaunched, a live turn).

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
- a start with no key.

`auth.*` are the owner's sign-in routes, recorded on a fresh server with accounts (the CLI's default) as the page meets them (same origin, the session cookie):
- no password yet;
- a password too short (422);
- setting it (201);
- signed in, and a read signed in (200) and without the session (401);
- setting it again (403);
- signing out;
- a wrong password (401), then the right one.

No password is recorded: a request that sent one lists only its field names (`body_fields`), and the session value is a placeholder.
