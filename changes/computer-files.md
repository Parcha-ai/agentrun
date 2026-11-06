---
packages: @parcha/agentrun-computer
kind: feature
---
Files move in and out of a computer through its daemon: `files.read`, `files.write`, `files.stat`, `files.list`, `files.mkdir`, `files.move` and `files.remove` on absolute paths (a relative one is `invalid`), and tar archives both ways without holding one in memory: `tar.pull.begin`, `tar.pull.read` (at most 512 KiB a read) and `tar.pull.end` read an archive as it is written, and `tar.push.begin`, `tar.push.write` and `tar.push.end` extract into a directory as the bytes come. Hello's capabilities gain `files`.
- A pushed entry that is absolute, has a `..` part, or would be written through a symlink out of the target directory is refused as `denied`; modes are kept (a directory's once the archive ends) and nothing is chowned; `files.move` without `overwrite` never replaces, even under a concurrent move; a push still open when the connection ends is ended, leaving no half-written file.
- `readFile`, `writeFile`, `pushTar`, `pullTar` and `pullTarStream` go past one call's limit; a pull reads a chunk only as its loop asks, so it can be piped into a push on the same connection. New error codes `exists`, `not_dir` and `is_dir`.
- The new daemon code copies from E2B envd and Kubernetes sandboxd (Apache-2.0), recorded in UPSTREAM.json.
