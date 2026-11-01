---
packages: @parcha/pi-transport
kind: breaking
---
**A checkpoint is never unpacked on the host: a box's links stay data, made again only inside the box a restore goes to**
- `pullCheckpoint` unpacked the box's archive into `localVault`'s directory with the host's general-purpose `tar -x -p`, so a box could make the host create symbolic links, hard links, named pipes and setuid files in the vault. Now the box sends only the bytes of the files the pull asks for, end to end; the vault keeps each file's content once, as a plain file of its own named by its SHA-256 and checked against it. Directories, symbolic links, hard links (`ManifestEntry.link`), named pipes (`kind: "fifo"`, which a checkpoint no longer refuses) and modes, setuid included, are the record's manifest and nothing else on the host.
- A listing with a path that is absolute, has a `.` or `..` segment, or goes through a link, or a file without a SHA-256, is refused before a byte moves (`failed`), and a record like that is never restored.
- A restore writes a tar stream from the record and the contents, and the new box's own `tar` makes the tree, links included. The tree is listed and hashed there against the record, hard links and pipes too.
- `CheckpointVault` gains `holds`, `keep` and `content`, and `VaultError` the code `refused`. `Checkpoint.filesRoot` and `PendingCheckpoint.filesRoot` are gone: read a checkpoint's files through `content(session, entry.sha256)`. A vault of your own adds the three methods.
- A generation an earlier version kept as an unpacked tree is `refused`, named in the restore's `no_checkpoint` message: it is never read, unpacked or restored. A pull after it takes the whole workspace again, and `prune` removes it with the generations it ages out.
