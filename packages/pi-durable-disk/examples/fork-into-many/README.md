# fork-into-many: fork one run into many

An agent drafts a release note in `work/` and the run is released at that checkpoint, which seals it. `forkLocal` copies the
sealed run three times. Each fork is a run of its own: it opens as generation 1 with the checkpoint's conversation and its
`work/` as it was, takes its own instruction ("rewrite the note for engineers / customers / auditors"), and goes on without
the others. The source stays sealed, byte for byte.

## Run it

From an install of the package instead of a checkout: this needs `@parcha/pi-durable-disk` **0.1.0-beta.14 or later**. `forkLocal` is not in 0.1.0-beta.13, where the example stops at its import with `The requested module '@parcha/pi-durable-disk' does not provide an export named 'forkLocal'`; [Run one from an install](../README.md#run-one-from-an-install).

You need Linux and Node 22.19 or later. No disk, no key, no network: the runs are directories of this machine (`localRun`)
and the agent is pi-ai's faux model, scripted.

```sh
npm ci --ignore-scripts && npm run build   # once, from the repository root; builds dist/
cd packages/pi-durable-disk
node examples/fork-into-many/main.ts       # about two seconds
```

The runs go under `./fork-into-many-run/` (removed first): `source/` and one directory per fork.

```
the runs live under /.../fork-into-many-run
checkpoint: generation 1 wrote note.txt and released the run, sealed
forked release-note into note-for-engineers: 2 files, 127045 bytes, sealed at 15
forked release-note into note-for-customers: 2 files, 127045 bytes, sealed at 15
forked release-note into note-for-auditors: 2 files, 127045 bytes, sealed at 15
generation 1 of note-for-engineers: 5 entries inherited, 4 added; note.txt: [engineers] Runs survive kill -9: ...
generation 1 of note-for-customers: 5 entries inherited, 4 added; note.txt: [customers] Runs survive kill -9: ...
generation 1 of note-for-auditors: 5 entries inherited, 4 added; note.txt: [auditors] Runs survive kill -9: ...
ok: one sealed run forked three ways, each fork continued on its own from the checkpoint, and the source stayed byte for byte
```

On a failure it writes `not ok: ...` to stderr and exits 1.

## How it works

[`main.ts`](main.ts) runs in one process.

- **The checkpoint.** The agent is a scripted model: asked to write the release note, it calls `write`. `run.setStatus("paused")`
  and `run.release()` seal the run: its `run.json` carries the store's last sequence.
- **The fork.** `forkLocal(source, [{ id, root }, ...])` copies the sealed run into one new directory per target, beside the
  target and renamed into place, so a failed copy leaves nothing. It only reads the source, and refuses a source that is not
  released and sealed (`ForkError` `SOURCE_NOT_RELEASED`). Each fork's `run.json` starts `paused` at generation 0 with the
  source's seal, so its first open is generation 1, and a copy that lost a committed sequence is refused.
- **Each fork goes on.** The fork opens with `localRun`, finds the checkpoint's conversation in its own store, and gets an
  instruction. The scripted agent answers "Rewrite work/note.txt for <audience>" by rewriting the note it finds in its own
  history, so only a fork that kept the conversation can produce `[<audience>] <the checkpoint's note>`.
- **The check** is the example's own: the source's files (sha256 and mode of every file) are the same right after the fork
  and after the forks ran; each fork opened at generation 1, held the checkpoint's `note.txt` before its instruction and the
  conversation, and wrote its own note; the source's `note.txt` is the checkpoint's; no fork holds another's note.

## What it does not show

A local fork guards one machine: a local directory has no mount to take the source exclusively, so nothing stops another
process opening the source while it is copied. Fork a run after it is released. `fork` (the CLI's `fork --id A --new-id B`)
does the same copy between runs of an Archil disk, under two exclusive mounts. The model is scripted, so the forks' different
answers come from their different instructions, not from a model's choice.
