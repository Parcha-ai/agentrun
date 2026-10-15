---
packages: repo
kind: feature
---
**Reference example: one scanner, and `--record` scans before it finishes**
- `examples/reference/scan.ts` is the one scan for what a published recording must never hold: a credential's shape
  or a machine path. A copied example keeps it.
- The recorder's `finishRecording` scans the recording's lines, its text blobs and the manifest's own text before it
  writes the manifest. A finding throws, naming the shape and the file, and no manifest is written, so the directory
  is never a finished recording.
- `scripts/recording/validate.mjs` imports the same scanner instead of its own copy, and re-exports it, so the
  validator and the hosted gallery's gate refuse exactly what the recorder refuses.
- The scanner refuses a JSON Web Token (`jwt`: a base64url JSON header and payload and a signature, the shape of a
  ChatGPT sign-in's access and id tokens) and a Browserbase API key (`bb_live_`, the prefix Browserbase's docs show), in
  a line, a blob or the manifest, and behind a JSON escape too. The source export keeps its own list
  (`scripts/export-source.mjs`), unchanged.
- The hosted gallery's gate scans every published text file as the recorder does, raw and decoded when it is JSON, so
  an escaped credential in a blob no line names is found too.
