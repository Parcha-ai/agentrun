---
packages: @parcha/agentrun-kernel
kind: fix
---
The model proxy reads an answer's content-filter stop and output-limit cut off each stream line once, as the line ends, instead of reading the last 64 KiB of the answer again for every piece. A long answer (about 1 MB, some 65,000 pieces) no longer holds the runner's thread for most of a minute, starving the run's store commits and claim renewals until the run never ended. A whole JSON body is read whole while it fits the window, so a stop in a pretty-printed body is still told before its client has it.
