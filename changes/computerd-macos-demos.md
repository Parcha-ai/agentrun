---
packages: repo
kind: fix
---
Computerd's `ui.act` stops with `aborted` when a person takes the Mac back: the keyboard or the mouse used since the act began stops it before a step that takes the foreground route and before every step after one, with nothing sent. Background keys keep the app's window key until they are handled (dropping the focus right after them ended Finder's rename and lost TextEdit's super+a), go to the target window when its app is already in front, typing at the focus is inserted through accessibility only into a text element of the target window, and a menu chord is pressed through its menu item only when the target window is the app's key window.
