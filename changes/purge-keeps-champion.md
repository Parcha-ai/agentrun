---
packages: @parcha/agentrun-serve
kind: fix
---
A run's purge takes off main only what that run put there: a learned workflow it revised goes back to the version before it, the newest no purged run wrote, so another run's champion keeps serving, and when the purged run's revision was the champion, the earlier champion serves again, even when that revision was held since; one it wrote new still leaves main. A check that ends after the purge records a hold for the purged revision, never a promote, and no compile revises that hold. A workflow still on main whose workflow.json a purged run wrote reads `410 purged` at `GET /agents/{agent_id}/learning/files/{file}`, and its approval or restore is refused the same way. A purge that can't read the learning folder's history answers 503 and takes nothing off main.
