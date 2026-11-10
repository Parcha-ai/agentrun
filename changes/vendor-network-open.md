---
packages: @parcha/agentrun-serve
kind: fix
---
A cloud phone starts on a server with the default box allow-list. A computer whose provider runs only on the vendor's own network (a cloud phone, a hosted browser: its declared network is `open` alone) now asks for `open` whatever the run's allow-list says, instead of the list it refused at create; this server's allow-list does not reach a network the vendor runs.
