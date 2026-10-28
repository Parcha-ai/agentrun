---
packages: repo
kind: fix
---
The source archive keeps source named `review`: a module `review.ts`, its `review.test.mjs`, and a skill directory named `review` were left out, so a package importing such a module did not build from the archive. Only review records (`*.review.json`) and the `.review` and `.reviews` directories are left out, and the export receipt lists `*.review.json`.
