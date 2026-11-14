---
packages: repo, @parcha/agentrun-computer
kind: fix
---
A `ui.act` settle compares what a person sees on the window: the nodes on it, with their bounds held inside it, and not which element each is. System Settings rebuilds its sidebar rows scrolled out of view on every read, makes its sidebar list a new height each time, and gives the row on the window's bottom edge a new element; Finder's status bar below the window counts the free disk space. So every act there waited out the 3 s `maxSettleMs`. Computerd's `ui.observe` bounds are now held inside the window, as the spec said, and its looks leave out scroll bars, whose size is the app's new guess at its content each read.
Computerd also reads less per act: its looks during an act skip each node's actions and settable (read only for the elements its steps act on), and an act with no steps settles from its first look. On CI's macos-26 runner a System Settings step went from about 4 s to 1.1 to 1.6 s (opening About, which the app draws in two passes, to 2.5 s), and Finder's four acts from 43 looks to 15.
