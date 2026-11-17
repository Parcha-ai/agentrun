---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose folder is on Archil and whose computer mounts that folder now removes its scratch (`.agentrun/tmp` and `.agentrun/output`) at its release. Before, the release logged `remove ".agentrun/tmp": … 409 OperationAborted … another client holds a write delegation` and left the scratch in the owner's folder. The release swept the scratch over Archil's file API before it let the computer go, while the computer's mount still held the folder's write delegation. Each such release also waited out the Workspace's 60 s retry window first. The release now lets the computer go (its final sync, then checkin) before it sweeps.
- Both the pi spec and the CLI harnesses' spec release in this order.
- The run's end still stops the run's background commands and removes its pull request checkout before it commits. Only the sweep moved, to after the computer's release.
- A park that keeps the computer sweeps nothing, as before.
