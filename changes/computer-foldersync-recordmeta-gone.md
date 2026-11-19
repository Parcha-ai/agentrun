---
packages: @parcha/agentrun-computer
kind: breaking
---
`FolderSync.recordMeta()` is gone. Nothing writes an Archil mount's modes and links to a synced folder's sink any more; a program that called it drops the call, and `sync()` writes a folder's modes and links as before.
