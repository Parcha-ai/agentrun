---
packages: @parcha/agentrun-serve
kind: fix
---
The workspace walk no longer leaves out what it cannot look at. In a directory that lists but cannot be searched (mode 0444, say), each entry's own look failed and the walk skipped it without a word, so a caller read the directory as holding nothing and could infer its files were gone. Each such entry is now reported refused as `unreadable`, and the rest of the run's files are still walked. An entry removed between the listing and its look is still left out, as it is gone.
