---
packages: repo
kind: fix
---
Settings → Tools never shows a stale result beside a provider changed elsewhere: it reads the capabilities again as it opens, and a row whose provider the capabilities were not read for says "reading…" until they are, then offers Retry if a read failed or the provider moved again. A save is never undone by an older read.
