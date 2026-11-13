---
packages: repo
kind: fix
---
Keep a remote worker's event batch unchanged until the destination acknowledges it, so a lost reply does not stop the native job when more events arrive before retry. New events wait for the next batch without re-executing the native task.
