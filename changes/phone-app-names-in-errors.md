---
packages: @parcha/agentrun-computer
kind: fix
---
A phone's error and observation texts name apps by their labels, not package ids. "org.wikipedia has no window on the screen (... of com.android.systemui ...)" now reads "Wikipedia has no window on the screen (... of System UI ...)". phoned reads the label through PackageManager (launcher app or not); where the phone gives none, the text keeps the id once, in parentheses after the words ("the app (org.example)"). Call arguments and structured fields keep package ids. The apps.launch refusals (not installed, no activity, refused start, force-stop) name the app the same way.
