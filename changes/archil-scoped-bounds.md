---
packages: @parcha/pi-durable-disk
kind: breaking
---
**The archil wrapper runs archil as root only in the shapes the claim uses, under a mount root that root owns**
- `bin/archil-scoped` used to pass every verb except `mount` straight to archil, and checked neither `mount`'s mountpoint nor its flags, so a sudoers rule for the wrapper granted more than the claim needs. It now runs archil only as `mount [--force] <disk>:/<path> <root>/runs/<run> --region <region>`, `unmount`, `checkin`, `sync` and `delegations --json` of a fuse.archil mount listed at `<root>/runs/<run>`, and acts itself only as `prepare <root>/runs/<run>` and its cleanup verbs (`retire`, `stray`, `stale`), each with exact arguments; archil gets an argv rebuilt from the checked parts. Anything else is refused with exit 2 before archil runs.
- Breaking: every verb now requires `<root>` and `<root>/runs` to be owned by root and writable by no one else, and no directory above them writable by others unless sticky, so the mountpoint is pinned against a race with its owner. Make the mount root root's (`sudo install -d -o root -g root -m 0755 <root> <root>/runs`); a mount root owned by the run user is refused. The run's mountpoint is made by the wrapper's new `prepare` (root makes it and hands it to the user sudo ran it for), which the claim calls when it cannot make the directory itself, in place of `sudo mkdir -p`. An empty mountpoint stays after its run is released.
- The reference's sudoers drop-in is unchanged (the wrapper, and `fusermount -u <mountRoot>/runs/*`); it says never to grant a bare `fusermount`, `mkdir` or `rmdir`.
- A test reads every archil call in the package's source and requires the wrapper to take each with its exact arguments, and to take no verb the package does not call.
