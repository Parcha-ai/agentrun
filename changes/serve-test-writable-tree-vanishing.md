---
packages: repo
kind: ci
---
serve's test cleanup no longer fails when part of a scratch tree is removed while it walks it. A fake box's command, or a server still closing, removes its own spool directories, and the walk that makes the tree removable now passes over a directory that is already gone. That fixes daytona-boxes' "a run found waiting at a start is pulled then" failing in its after hook with ENOENT on a box's `tmp/pi-transport/<id>/in`.
