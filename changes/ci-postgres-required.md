---
packages: repo
kind: ci
---
The store on Postgres is a required check: `verify` needs the "serve store on Postgres" job (its least-privilege case included), so a pull request that breaks the Postgres store can't merge, and a release waits for it on main.
