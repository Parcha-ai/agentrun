---
packages: @parcha/agentrun-computer
kind: fix
---
A Daytona computer starts on runners whose toolbox has no `/files/upload-v2`, as a self-hosted Daytona's may: when the toolbox answers 404 for it, the daemon goes in through `/files/upload`, which takes the same form. Any other refusal of the upload fails the create as before, and an error after the fallback names both routes.
