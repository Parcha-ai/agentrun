---
packages: @parcha/agentrun-serve
kind: fix
---
SDK compile asks are held to the run's cap.

A backend SDK run's end-of-run compile ask is judged by the run's cap before it leaves, as every other paid step is: on the run's whole spend (the job its backend reported and every ask before it) and at its whole output bound. One that would pass the cap is not sent and books nothing; its learning is dropped as "Skipped: no budget left in this run to write what it learned.", and the run keeps the job's cost and outcome. Its requests on free models now count toward the run's limit of them (`AGENTRUN_FREE_MODEL_REQUESTS`).
