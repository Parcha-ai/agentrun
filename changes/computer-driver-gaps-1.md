---
packages: @parcha/agentrun-computer
kind: fix
---
Three driver gaps closed. The Android and macOS ui fixtures now have the Code field (id `code`), which takes back any value set into it, so `ui.set-holds` runs on phones and Macs instead of skipping. The Android fixture still has no New window, because a phone app has one window. On macOS, `ui.observe` names a window's title-bar buttons from their accessibility subrole (Close, Minimize, Zoom, Full Screen) when the app gives them no title or description.
