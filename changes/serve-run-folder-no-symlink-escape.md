---
packages: @parcha/agentrun-serve
kind: fix
---
On macOS, a run's folder can no longer be used to reach host files through a symlink swapped in mid-walk. Every file or folder serve opens in the run's folder is opened with O_NOFOLLOW_ANY, so a link anywhere on the way fails the open: a read, a file GET, a write, an append or grep never opens a host file, however the swap is timed. The end-of-run sweep removes a link itself, never what it points at. On Linux, behaviour is unchanged (it was already safe through O_NOFOLLOW and /proc/self/fd). On a host that is neither Linux nor macOS there is no way to refuse a link on the way, so a local run's file calls there fail instead of following one.
