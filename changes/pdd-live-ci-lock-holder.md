---
packages: @parcha/pi-durable-disk
kind: ci
---
**The live-ci lock test leaves no process behind**
- The test that shows a held lock refusing a second live run held the lock with `flock <lock> sleep 30` and killed that flock at the end. flock forked the sleep, which kept the lock's descriptor and outlived the test by 30 seconds on every run, holding the lock. It now starts the holder with `flock --no-fork`, so the process it kills is the one holding the lock, and it checks that the lock is free again once the holder has exited.
