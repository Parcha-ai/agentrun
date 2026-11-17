---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/runs?status=…` and `GET /v2/agents/{id}/runs?status=…` read only the runs still going over their journals: an ended run's status comes from its row, the status its view already gave. The filter rebuilt every run's view to compare statuses, so its time grew with every run the server held (about 1.2 s at 100 runs, on the server's main thread), and Mission Control's Needs you strip asks three of these lists every 10 s, which slowed every other request while the console was open. At 100 runs the three lists now answer in a few milliseconds each.
