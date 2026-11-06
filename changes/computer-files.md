---
packages: @parcha/agentrun-computer
kind: feature
---
Files move in and out of a computer through its daemon: `files.read`, `files.write`, `files.stat`, `files.list`, `files.mkdir`, `files.move` and `files.remove` on absolute paths (a relative one is `invalid`), and tar archives both ways without holding one in memory: `tar.pull` streams the archive as `tar.data` notifications of at most 512 KiB, stopped by `$/cancelRequest`, and `tar.push.begin`, `tar.push.write` and `tar.push.end` extract into a directory as the bytes come. Hello's capabilities gain `files`.
- A pushed entry that is absolute, has a `..` part, or would be written through a symlink out of the target directory is refused as `denied`; modes are kept and nothing is chowned; a push still open when the connection ends is ended, leaving no half-written file.
- `readFile`, `writeFile`, `pushTar`, `pullTar` and `pullTarStream` go past one call's limit; `DaemonClient.call` takes `onNotification` for the notifications that name the call. New error codes `exists`, `not_dir` and `is_dir`.
- The new daemon code copies from E2B envd and Kubernetes sandboxd (Apache-2.0), recorded in UPSTREAM.json.
