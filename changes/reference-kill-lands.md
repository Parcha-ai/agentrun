---
packages: repo
kind: feature
---
A `--kill` with `n` counts every crossing of its point and lands at the first eligible one at or after the nth (not while a tool call is between its dispatch and its kept answer), so it always lands when the run reaches the point n times or more; the kill line's `crossing.n` is the ordinal it landed on, `DemoResult.kills` carries `n` and `planned`, and the summary says `planned n=10, landed at n=12` when they differ.
