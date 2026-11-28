---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose sandbox, desktop or phone was made with network `none` now tells the agent at the start: its first model request carries a server note saying that nothing on the computer reaches the internet, that a page, a download or a package install from the internet fails there, and that it should say in its answer what needed the internet instead of retrying. The note also says that tools that don't run on the computer aren't affected. A computer gets `none` when its provider makes no other network (an Orgo Linux desktop) or when the run allows none. The person reading the run sees the note once on its timeline, as the server's row. A resumed claim never repeats it. A computer with an allow list or an open network gets no note, and neither does a paired computer, a browser, or a `--faux` computer.
