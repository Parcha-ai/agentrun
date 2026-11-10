---
packages: repo
kind: fix
---
The New schedule, webhook and GitHub trigger forms' cost cap field shows the picked agent's own default cap as its placeholder ("$5.00, the agent's default"), which an empty field takes, and no placeholder when the agent has none, where it showed a made-up example ("2"). A schedule's one time and an interval's start are picked to the minute (no seconds); the time sent keeps its shape.
