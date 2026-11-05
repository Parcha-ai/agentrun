---
packages: repo
kind: ci
---
serve's secret-custody test reads a live run's files while the run goes on, and a file that goes between its listing and its read (the run's empty launch mark, removed once its process serves) no longer fails the test with ENOENT. Such a file holds nothing; any other read error still fails, and a file that holds a key is still found. This ejected a merge-queue run on 11-04 (F31).
