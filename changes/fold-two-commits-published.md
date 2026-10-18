---
packages: repo
kind: fix
---
`changes.mjs --fold` writes a published package's dated section in one order whether a release folds once or in two commits. A later fold used to append its bullets at the end of the version's section; one fold groups the section by kind and orders it by fragment name. When the section is exactly an earlier fold's output (its fragments gone from the tree, present at the merge base), the fold now rebuilds it from the merge base's text with the earlier and the new fragments together in fold order. A section edited by hand since is left as it was and the new bullets go at its end, and `--check` still refuses the edit. This extends the held-package rule to published changelogs.
