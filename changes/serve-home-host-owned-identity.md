---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's home matches its host-owned names by identity: a path's first segment is compared folded (compatibility form, any case, no combining marks) and, where it and `learning/` are both on disk, by device and inode. Home paths take only plain segments, each its own NFC form with no default-ignorable code point; any other is `400 invalid_file_path`. The home path checks are in their own module, `home-path.ts`.
