---
packages: repo
kind: fix
---
**The validator refuses a box line that names its box by its provider's id (draft 39)**
- `scripts/recording/validate.mjs` refuses a `box.created`, `box.killed` or `box.ended` line whose `box` is not a `box-N` label. A recording names a box by its label, by first appearance, never by the id its provider gave it. `apps/viewer/RECORDING.md` section 7 says so.
- The three viewer test fixtures that named their boxes by provider ids (`transport-route-docker`, `transport-route-real`, `transport-t4-wait`) now name each box by its label, `box-1`, `box-2`, … in the order it was made, consistently on every line that names it.
