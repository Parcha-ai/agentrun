---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose folder is on Archil and whose computer mounts that folder now removes its scratch (`.agentrun/tmp` and `.agentrun/output`) at its end. Before, the release logged `remove ".agentrun/tmp": … 409 OperationAborted … another client holds a write delegation` and left the scratch in the owner's folder. The run's end removed the scratch over Archil's file API while the computer's mount still held the folder's write delegation, and each such end first waited out the Workspace's 60 s retry window. The run's end now removes the scratch through the computer when it mounts the folder; the computer's deletes sync to the disk before they answer.
- The sweep still runs at the run's end, before its end commit. A follow-up that the commit reopens, claimed at once in the same folder, keeps its own scratch.
- If the computer no longer answers, a Mode 1 run's sweep removes through the run's own folder, as before. A Mode 2 run's scratch stays, and the release logs why.
- Both the pi spec and the CLI harnesses' spec sweep this way.
