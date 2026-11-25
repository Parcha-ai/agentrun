---
packages: @parcha/agentrun-import
kind: fix
---
A Codex cursor saved by 0.1.0-beta.59 or before is read from its file's start (`resumed: false`) instead of resumed: its state held the open request as an object this release does not read, so a usage appended after it made a second request. `lineReader` sources can set `stateVersion` for the same reason; a cursor saved at another version is not resumed.
