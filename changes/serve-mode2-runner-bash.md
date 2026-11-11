---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2 (Archil), an agent on the runner (computer kind `none`, or no place named) may name `bash`: its save, its run's start and a template's apply ask where this server's runner has its shell (`bash` on Archil's serverless exec) instead of refusing it with `422`. `capabilities.tools` shows `bash` available there. The background tools still need a box, and in Mode 1 `bash` on the runner is refused in the same words as before.
