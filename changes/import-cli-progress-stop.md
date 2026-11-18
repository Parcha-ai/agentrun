---
packages: @parcha/agentrun-serve
kind: fix
---
`import` says what it is doing and what it did. On a terminal it shows one progress line (looking for sessions, checking them for keys, importing N of M), cleared before the summary. The first Ctrl+C stops it after the session being saved, says so, prints the summary with a `Stopped: imported N sessions …; run the import again for the rest` line, and exits 130; a second Ctrl+C quits at once. The summary says how many sessions this import took and into how many agents (`Imported 76 sessions into 3 of 7 agents`), or `Nothing new to import` when every session is held already, instead of `Imported into 7 agents` on a run that took nothing. With no `--port`, the last line no longer promises port 7340, which a server passes over when it is taken: it says to start the server and open the address it prints. An import refused because a running server holds the store says to stop the server first.
