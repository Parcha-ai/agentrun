---
packages: repo, @parcha/agentrun-computer
kind: fix
---
A `ui.act` settle compares only the nodes on the window: a node wholly outside it no longer holds a settle or counts as a step's effect. System Settings rebuilds its sidebar rows scrolled out of view on every read, and Finder's status bar below the window counts the free disk space, so every act there waited out the 3 s `maxSettleMs`. Computerd's looks during an act also skip each node's actions and settable (read only for the element a step acts on), which halves a look on SwiftUI windows. A System Settings step on CI's macos-26 runner went from about 4 s to under 1.5 s.
