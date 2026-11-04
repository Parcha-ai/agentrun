---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: feature
---
A run that learns gets the skills its agent wrote beside its revision's own. Each is a folder `skills/<name>/` on the learning folder's `main`, copied into the run's `work/.agents/skills/<name>/`: pi and codex read its `SKILL.md` in their prompt, and claude-agent loads it through its Skill tool when its adapter takes it.
- A skill named like one of the revision's is the revision's. Only an active skill is served: one whose `SKILL.md` sets `status: pending` (held for its owner's OK), or any status but `active`, is not.
- Learned skills get their own budget, 256 KiB of files in all, and never more than the revision's skills leave of the 1 MiB an adapter takes of a run's skills, so they never push the revision's back into the prompt. The one changed last comes first, each whole while it fits; one that does not fit, or that holds one of the server's secrets, is left out.
- The run's pin (`runs/<id>/learning.json`) names the files laid (`skills`) and the skills left out (`skills_left_out`). A follow-up gets them laid again, fresh. A learned skill the run's work no longer holds whole when its process starts is left out of what the harness gets, and the run goes on.
- A symbolic link or a submodule at `skills/` or under it is a learning fault: the run starts with nothing learned (`seed_failed`).
- `@parcha/agentrun-kernel` exports `SKILL_BYTES`, the 1 MiB its `skillProblems` takes of a host's skills in all.
- A person retires a learned skill or a workflow draft as they retire a note: `POST /v2/agents/{id}/learning/files/{file}/retire` with If-Match on its `skills/<name>/SKILL.md` or its draft's `workflows/<name>/README.md` (percent-encoded). It sets `status: retired` in one host commit (`learning: retired by a person: <file>`), the learning view lists it `retired`, and no later run is given it. A stale ETag is 412, and the token may retire as it may retire a note; only an approval takes the owner's session.
