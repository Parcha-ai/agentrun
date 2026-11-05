---
packages: repo
kind: ci
---
serve's dwf test of a run's graph read while it is paused mid-map bounds each read at 10 s, not 1 s. A read that waited on the paused run's store would wait until the resume, and one that met a busy store answers at once marked stale (still asserted), so the bound only clears a slow runner: one answered in 2.6 s and ejected a merge-queue run on 11-05 (F30).
