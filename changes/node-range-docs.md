---
packages: repo
kind: docs
---
**The checkout's docs name the Node range its scripts accept**
- The contributor guides, the tutorials, the demos' setup prompts and the examples run from a checkout now say Node 22.19 or newer on 22, or 24.2 or newer. That is the range `scripts/check-node.mjs` accepts: Node 23 and 24.0 to 24.1 have no `import.meta.main`. The published packages still need Node 22.19 or newer.
