---
packages: repo
kind: docs
---
**`apps/viewer/RECORDING.md` follows the format's draft 25**
- A supervisor's `kill` line may say what was killed: `kind` is `process` when only the run's process died and `box`
  when its whole machine or sandbox was taken away. Absent means `process`, and a panel never guesses `box`.
- A JSON result blob may be `agentrun.cited/1`: rows of a label, a value and its cites, each naming a blob, a look or
  both, with a fragment in pi-vision's form, and optionally the `url` the evidence was read from and the time `at`. A
  cite with a url and no blob or look is shown as linked, not kept; a row with no cite says on screen that it cites
  nothing.
- The manifest may name the `job` that ran and the run's `store` at the end, each as a blob, and other recorded runs
  of the same demo in `see_also`, linked only.
- Repeated and asked twice count the browser's replay-unsafe page actions, by `(conv, tool, codeSha)` from the session
  records' `pendingEffect` entries: each later dispatch of an action that already reached the page counts once, and one
  after a dispatch that shows no sign of reaching it is possible, never proven. A recording that keeps only the latest
  session records shows page actions not measured.
- A look live lines show started is not a possible extra payment when a later process filed its key as kept: that
  filing is the same answer read back, already counted.
