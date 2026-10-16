---
packages: repo
kind: feature
---
`--record` follows the run: `events.jsonl` is appended to as the lines arrive (whole lines, section 3's order, a memo after its commit is complete), blobs are written whole before any line names them, and the manifest is last, so a viewer in follow mode reads a live run and its replay as one file; the finished file equals a fresh export. The manifest's `job` blob is always written when the entry knows the job.
