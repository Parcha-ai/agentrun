---
packages: @parcha/agentrun-serve, @parcha/agentrun-learn
kind: feature
---
A person sees and controls what an agent has learned, through the API (`learning/1`): `GET /v2/agents/{agent_id}/learning` (the index, the notes, the log of changes by run or by person, and the runs' counts), its `notes` and `log` pages, one note as text with its `ETag`, and `GET /v2/runs/{run_id}/learning` and `.../learning/diff` for one run.
- `PUT /v2/agents/{agent_id}/learning/files/{file}` edits a note (`If-Match`) or creates one (`If-None-Match: *`), and `POST .../retire` retires one; a stale ETag is 412, a write with no precondition 428 (`precondition_required`, a new error code). A person's note passes the same structural checks as a run's, with no grader, and lands as one host commit on `main` with a `Changed-By: user` trailer and `MEMORY.md` rebuilt. A refused note is 400 with `problems` on the error.
- `@parcha/agentrun-learn`: `checkNote(path, bytes, refuseValues)` checks one note by itself, as a person writes it; `retire(text)` marks a note retired; `secretShapes` and `valueMatcher` are exported.
