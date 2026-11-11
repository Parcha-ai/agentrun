# Recorded fixtures

Responses of AgentRun Server's `agentrun.v2/0`, recorded from a seeded server on its scripted model (synthetic content,
no key, no network) with the dev kit that has since been removed. Each file is `{request, status, headers, body}` as the
server answered.

They are kept in step with the contract by editing, not by recording again: when the served document makes a field
required, it is added to every fixture that answers that shape, with the value today's server sends on the faux model.
That is how a run's `place` (`{"mode": "runner"}`) and capabilities' `places` (with `default_place`) and `learning` came
in on 2026-11-11. No test checks the fixtures against the document, so an edit to the contract that changes a shape
these files hold edits them in the same change. Keep the rest as recorded.

Names: `run.<status>.<state>.<n>` is a run in that status and state, with `.timeline` and `.files` for the same run.
`run.with-files.*` is a run with an output file and that file's bytes. `error.*` are the server's typed errors.

Two recordings on 2026-10-28 from the same seed: one right after a restart (`run.working.idle.1`, `run.queued.working.1`:
runs not yet relaunched) and one 15 seconds later (`run.working.working.*`: the same runs relaunched, a live turn).

`capabilities.json`'s `tools` and `harnesses` are later recordings than the rest of that file (2026-11-03, a server on
the faux model with no keys): the console reads a tool only as the object serve sends, and a harness's default model only
from its `default_model`, and the first recording had bare tool names and no `default_model`.

`timeline.legacy.<state>` are one pi run's timeline (`GET /v2/runs/{id}/timeline`), recorded by its timeline projector:
a call row then its result row. `completed` is the run settled, `working` the same run live, a write still running. The run reads a missing file, reads three, searches and fetches the web, fails
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

`learning.*` are one agent's learning, recorded from a faux server with learning on (`learning-demo/`: `serve.mjs` starts
agentrun-serve on `faux-refunds.mjs`, a refund-policy finder that works slowly until it has notes and reads each note first
once it does; `seed.mjs` runs it six times; `record.mjs` records). Taylor Stitch's run keeps the first note, Brooklinen's
keeps a better one that replaces it, a person adds a note of their own, Kith's note is not kept (about one shop only), and
three runs have nothing new. Then, in order: the agent, its learning, its runs and its stats; a person opens a note
(`learning.note`), someone else saves a change to it (`learning.note-theirs`), the person's save on the version they
opened is refused (`learning.note-stale`, 412), the newest version (`learning.note-newest`), a save with a hidden
character the checks refuse (`learning.note-refused`, 400 with `problems`), the clean save (`learning.note-saved`) and the
learning after it; the person's own note read and retired, and the learning after that. `learning.off-*` are an agent with
no notes and learning off: its learning, its runs, the definition saved with learning on, the agent read again after it
(`learning.off-agent-after`, as its page reads it), and its learning after.
They are recorded from a server that says what each run read and kept (`used`, `learned`, on a run and in every list)
and the agent's before and after (`impact`): two Brooklinen and Allbirds runs, the agent's runs and its learning carry
them. Each note in the learning carries its `etag`, the same value as `learning.note`'s ETag, so the console edits and
retires on the version a card shows; the note's own reads are kept for the reload after a refused save. The runs list
carries each run's learning in words (`detail`), and the impact each side's time to the answer, the job's own cost and
what learning itself costs a run.
`learning.diff-run` and `learning.diff` are a pair from one later recording of the same story: Brooklinen's run, and what
its learning changed (`GET /v2/runs/{id}/learning/diff`: the note it added, the note it replaced, and the index), for
the run page's "What it changed". `record.mjs` records them with the rest; until the set is recorded again whole, their
run is not the one in `learning.runs`.
To record them again: build the server and the console, then `node serve.mjs ...`, `node seed.mjs <url> <data>` and
`node record.mjs <url> <data> apps/console/src/fixtures`. No token is written: the token stays in the data directory.
