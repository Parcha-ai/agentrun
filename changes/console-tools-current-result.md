---
packages: repo
kind: fix
---
Settings → Tools never shows a stale result beside a provider changed elsewhere: it reads the capabilities again as it opens, and a row whose provider the capabilities were not read for says "reading…" until they are. Each harness's resolution carries the server's own sentence on why, when the server gives one.
