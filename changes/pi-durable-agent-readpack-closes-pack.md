---
packages: @parcha/pi-durable-agent
kind: fix
---
`readPack` and `importPack` no longer leave the pack file open when they cannot make their scratch directory (a full or unwritable temporary directory): the file is closed before the error is thrown.
