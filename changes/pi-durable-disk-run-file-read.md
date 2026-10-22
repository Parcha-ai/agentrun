---
packages: @parcha/pi-durable-disk
kind: feature
---
`readRunFile(control, ref, path)` and `listRunFiles(control, ref, dir)` read a run's own files over the disk's control (S3 GET, HEAD and LIST): they never mount, write, or take or wait on the claim, so they read a run another host holds. `readRunFile` returns the bytes, or `null` for a file not written yet; `listRunFiles` returns the names directly under a directory, sorted, names only. Refusals are `RunFileError`: `INVALID_PATH` (before any request: absolute, `.`/`..`, unsafe characters, `.archil/`), `RUN_MISSING`, `NOT_A_FILE` (a directory, or a symlink, decided on Archil's 501 for it, never from a listing, where a symlink looks like an empty file), and `CONTROL_API_FAILED`. Both take a `signal`.
