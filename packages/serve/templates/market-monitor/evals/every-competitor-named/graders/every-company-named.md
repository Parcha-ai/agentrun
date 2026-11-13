---
type: llm
---
Read the run's answer: its last fenced `json` block, and the `digest` text in it.

Pass only when all of these hold:

1. The digest reports Quillforge's Team plan going from $49 to $59, with its link.
2. Tallyhawk appears in the digest with its own line saying nothing new this week (or the same in other words) and
   naming what was checked for it (its pricing page, its changelog, or both). A digest that leaves Tallyhawk out, or
   only lists it among companies without saying it was checked, fails.
3. Nothing is reported as a change at Tallyhawk: its prices did not move and its changelog entries are older than the
   window.
4. `quiet` is false.

Answer pass or fail, and quote Tallyhawk's line.
