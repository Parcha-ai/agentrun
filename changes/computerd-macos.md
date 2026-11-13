---
packages: repo
kind: feature
---
Computerd.app, a driver for a person's own Mac (`packages/computer/daemon-macos`, Swift): it speaks the computer protocol 0.2 over a unix socket, through its `computerd` command (the stdio binding, for SSH), and over the attach binding, dialing a paired server with no open port. It answers `hello` (screen in points and scale, each feature on or off with the reason), `exec`, `files`, `tar`, `screen`, `apps` (launch in the background) and the `ui` group: `ui.observe` reads a window's accessibility tree with its image, and `ui.act` takes each step on the first route that can do it, semantic (accessibility actions, values set and read back), then background (SkyLight input posted to the app's window, which never moves the pointer or raises the window), then foreground only when the call allows it. Install and pairing steps are in its README; CI builds, tests and smoke-tests it on `macos-26`.
