---
packages: @parcha/agentrun-pi
kind: fix
---
A fork of a workflow node's conversation no longer hangs. The node's configuration document (`agentrun.node`) was forked with the conversation, so the fork's first request waited for the node runner, which never reaches a fork. A fork now starts without it, as it already did without the node's record: it is no node, it answers on its own, and a `submit` in it is refused as in any conversation that is no workflow node. A host that reset the document in the fork by hand can drop that step.
