---
packages: repo
kind: fix
---
The console's Learning tab builds each revision chip's text in one place (`standingOf` returns the word and what it was decided on), and a replay line says "N skipped" while the promotion record's reason says why and what a refit moved. The console no longer keeps its own copies of the skip and refit sentences, so serve's wording is the only wording.
