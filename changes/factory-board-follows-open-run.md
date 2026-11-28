---
packages: @parcha/agentrun-serve
kind: fix
---
Agent Factory's board now reads its sessions again when the run open beside it starts or ends, so its counts and cards follow that run at once. Before, the board read again only when something was done in the panel (a message, an answer, a stop), which is before the run moved, so a run starting or ending showed only at the board's next read, up to 10 seconds later.
