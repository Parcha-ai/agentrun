---
packages: repo
kind: ci
---
serve's store-busy test of a message to a working run bounds each answer at half the revision read's retry (15 s of 30 s), not at 6 s: CI's slowest runners answered at 6.0 to 6.5 s and failed it on four pull requests and a merge-queue run on 11-05 (F34), while a message that waited on the read would answer at 30 s. A server whose message path makes that read still fails it, at 30 s.
