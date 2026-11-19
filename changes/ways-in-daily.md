---
packages: repo
kind: ci
---
Every way in is walked on main each day (`ways-in-daily.yml`): the README's `npx @parcha/agentrun` as published, the launcher, and Docker Compose, Railway, Helm, Coolify and Dokploy on main's image. A red run opens or updates the issue `ways in: <rows> broke`, and the next green run closes it.
