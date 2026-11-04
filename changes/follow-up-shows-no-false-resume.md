---
packages: @parcha/agentrun-serve
kind: fix
---
A follow-up to a run that answered, or that the person stopped, no longer shows "Resumed after the server stopped" in the run's timeline. Once a run answers, its server lets its process go, and the process recorded that the same way as a server stop, so the next open read it as one. The server now tells the run's process when it opens the run for such a follow-up, and that open writes no "resumed" row. A run a server stop or a crash cut still shows its row when it resumes.
