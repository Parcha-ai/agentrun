---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow model node's tool call that was let through, then run again on the next claim after its runner went (or its lease lapsed), with its tool now set to deny, tells the model that whether the call took effect is not known. It used to say that nothing was sent and nothing was charged, which is false of a call that may have reached its host.
