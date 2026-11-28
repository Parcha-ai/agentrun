---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose sandbox, desktop or phone reaches less than the internet now tells the agent so at the start, in a server note on its first model request:
- A computer made with network `none` has no internet access. A page, a download or a package install from the internet fails there. A computer gets `none` when its provider makes no other network (an Orgo Linux desktop) or when the run allows none.
- A computer made with an allow list reaches only the list's hosts, on ports 80 and 443, and anything else from it is refused.

Either way the agent is asked not to retry what fails for that reason and to say in its answer what needed it. Tools that don't run on the computer aren't affected. The person reading the run sees the note once on its timeline, as the server's row, and a resumed claim never repeats it. A computer with an open network gets no note, and neither does a paired computer, a browser or a `--faux` computer.
