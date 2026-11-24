---
packages: repo
kind: ci
---
The store's suite on Postgres is part of the required `verify` check. A red `serve store on Postgres (k/4)` job now blocks a pull request and the merge queue, where it was advisory before.
