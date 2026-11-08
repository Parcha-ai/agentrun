---
packages: @parcha/agentrun-serve
kind: fix
---
Learning runs on git 2.32 or later, the floor its own git calls need, instead of 2.40, so a host or a serverless exec image with git 2.34 keeps a learning folder. A host below 2.32 still keeps none and says which git it found. Upgrading: nothing to do.
