---
packages: repo
kind: fix
---
The source archive keeps source named `review`: a module `review.ts`, its `review.test.mjs`, and a skill directory named `review` were left out, so a package importing such a module did not build from the archive. Only review files (a file named `*.review.*`, such as the author's `<n>.review.json`) and the `.review` and `.reviews` directories are left out; a directory named like a review file is not.
