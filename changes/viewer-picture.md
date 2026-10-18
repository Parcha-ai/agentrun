---
packages: repo
kind: feature
---
**`apps/viewer`: the run's picture (RECORDING.md draft 31)**
- The picture panel draws the latest `picture` host line's image at or before the stop, a gap before the first, and the
  last one after the run ends. A recording with no `picture` line draws no picture panel; one with pictures shows it
  first.
- The viewer's format check takes a `picture` line, which names no process (no `data.gen`), and checks its `blob` (a
  SHA-256 in `blobs/`), `label` (a string) and `commit` (a whole number).
- `apps/viewer/RECORDING.md` follows the format's draft 31: the host row gains the supervisor's failure lines and the
  `picture` line.
