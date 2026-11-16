---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose revision has skills, whose folder is on Archil and whose computer mounts that folder no longer fails at its claim with `mkdir ".agents/skills": … 409 OperationAborted … another client holds a write delegation`. The claim now lays the revision's skills, and a learning run's seed, in the run's folder before it starts the computer. Before, it laid them after the computer's mount had taken Archil's write delegation for the folder. The disk then refused each write over its file API, and the run failed once the Workspace's retry window ran out.
- Both the pi spec and the CLI harnesses' spec lay in this order.
- A later claim of the same run lays only the skill folders that are missing. The folders an earlier claim laid, and the run's edits to them, stay as they are.
- Before, a learning run's seed failed silently under such a mount: the run started with no learned notes or skills laid.
