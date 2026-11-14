---
packages: repo
kind: fix
---
Computerd (the macOS driver) settles a `ui.act` on the app's accessibility notifications instead of reading the window until two reads match. It watches each app it looks at with an AXObserver (values, titles, elements made, focus, selection, layout, the window's place and size; not elements destroyed or row counts, which apps tell for what a read itself made), waits after a step until the app told nothing for the quiet, reads the window once, and reads it again only when the app told a change after that read began. An act's steps start from the observe just before it when the app told nothing since. One read of System Settings' window costs 260 to 860 ms on CI's macos-26 runner, and a step there took three to five of them.
