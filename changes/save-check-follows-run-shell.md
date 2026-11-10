---
packages: @parcha/agentrun-serve
kind: fix
---
Saving an agent with no computer now uses the same rule as its runs. With Archil storage (Mode 2), such an agent saves with `bash`, which runs on Archil's serverless exec, and is refused the background tools (`bash_background`, `bash_output`, `bash_input`, `bash_signal`, `bash_list`) in words that point to a sandbox computer. With the run folders on the server's own disk (Mode 1), it is still refused `bash`, and the refusal says a shell needs a sandbox computer. A desktop whose provider mounts the run's folder keeps all of them.
