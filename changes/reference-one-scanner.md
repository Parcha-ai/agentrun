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
