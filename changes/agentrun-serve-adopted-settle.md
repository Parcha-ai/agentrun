---
packages: @parcha/agentrun-serve
kind: fix
---
A run that a restarted server adopted now ends final after it answers. The server read the run's store as soon as the run said it was released, while the run's process could still hold the store's exclusive lock until it exited; that read failed with `database is locked`, was not retried, and left the run `completed` but never final until the next start. The server now reads an adopted run's store once its process has exited (it reads anyway, and says so, if the process lives on 30 s after it released the run), retries a store that another connection holds within the same bounded retries as a busy agent home, and writes each wait and a run it could not settle or recover to stderr.
