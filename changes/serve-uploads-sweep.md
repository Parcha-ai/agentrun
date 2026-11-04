---
packages: @parcha/agentrun-serve
kind: fix
---
A start clears the temp files a crashed upload left: a file sent in one call leaves `.incoming.<pid>.<hex>.tmp` in `DIR/files/`, and a PUT leaves `bytes.<pid>.<hex>.tmp` in the file's folder. The sweep runs under the data directory's lock, before the server answers anything, so no upload of its own is in flight. It matches only those exact names and removes only regular files: a link named like one is not followed or removed, a `DIR/files/` that is itself a link is not swept at all, and a file's bytes and record stay. A start that removed any logs `event=uploads_swept removed=N`.
