---
packages: @parcha/agentrun-computer
kind: fix
---
computerd's tar extract makes a directory an entry's path needs, but the archive doesn't name, `0755` whatever the umask (under init's `umask 077` it came out `0700`), which is fine since the sandbox has one user, so a `FolderSync.push` of files without their directories no longer records a `0700` mode in the folder's meta.
