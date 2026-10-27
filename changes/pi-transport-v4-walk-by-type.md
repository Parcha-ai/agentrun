---
packages: @parcha/pi-transport
kind: fix
---
The launcher's check of a tools user (`toolsUser`) walks its mounts by filesystem type and no longer fails on a pseudo filesystem. It walked every mount without `nosuid`, so `/proc`, where a process ends mid-walk, made `find` exit non-zero and the check refuse the launch (seen on a VM whose `/proc` has no `nosuid`). The kernel's pseudo filesystems (`proc`, `sysfs`, `cgroup`, `cgroup2`, `devpts`, `mqueue`, `securityfs`, `debugfs`, `tracefs`, `bpf`, `pstore`, `configfs`, `fusectl`, `binfmt_misc`, `efivarfs`) are skipped, and every other type, an unknown one, `tmpfs` and `devtmpfs` included, is still walked, so a setuid root file on any of them is still refused. The walk ignores an entry that vanishes mid-walk only where `find` takes `-ignore_readdir_race`, found by running it; a `find` without it keeps the strict walk and a vanished entry stays `unsupported`, as does every other `find` error.
