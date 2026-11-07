---
packages: @parcha/pi-transport
kind: fix
---
A local box's `destroy` (and its lifetime watchdog) now ends a launched program that cleared its environment, with its whole process group. Before, `destroy` found a box's programs by their record, trusted only while the process that started them still ran, and by the box's marker in their environment, and it killed each one alone. A launch runs its program with the environment its spec names, so once its runner was gone, a program deaf to SIGTERM outlived the box, reparented to the user's init and still working in a workspace that had already been removed. `destroy` now also finds a process by its working directory inside the box's directory, and ends each program it finds together with its process group, never the caller's own group.
