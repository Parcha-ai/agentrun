---
packages: repo
kind: docs
---
The docs match the beta's code. The server README describes an agent's computer (`computer: {kind, provider}`, Settings → Computers, Mode 1 and Mode 2 on Archil) in place of the boxes, says where `bash` runs (in a computer that mounts the run's folder; on Archil's serverless exec in Mode 2, with its 295 s bound, no stop once sent, no kept file mode and no link followed; nowhere in Mode 1 without such a computer), that an escalated workflow run ends `completed` with a `review`, the run's `pending` kinds and the webhook's, that a trigger's run is titled from its trigger, that a GitHub App token is minted again 5 minutes before it expires, that an agent keeps its own tool pins (the template READMEs too), and that a server in a container can't start a Docker sandbox yet. The contributing guides build the computer daemon before `verify:packages`.
