---
packages: repo
kind: fix
---
A template's title on the Templates page and its Apply screen never shows a raw `${parameters.<name>}`. Before apply, the card reads "…" in its place ("Code review: …"), and the Apply screen fills it live with what you type ("Code review: acme/web"), as the server fills the made agent's name.
