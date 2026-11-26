---
packages: @parcha/agentrun-computer
kind: fix
---
A Modal computer keeps its labels packed, as Kubernetes and Cloudflare computers do: two tags, the computer's name and the labels deflated. A computer with an Archil mount, a network list and a run's labels came to more than Modal's 512 bytes of tags as they were, so check() refused it and no sandbox started. A sandbox made before the change still lists, attaches and is swept by the labels it carries as tags (`facts.labels.packed.unpacked`). A Modal computer may now carry more than 10 labels, as long as they pack into Modal's 10 tags and 512 bytes.
