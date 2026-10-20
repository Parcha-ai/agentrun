---
packages: @parcha/pi-durable-disk
kind: fix
---
A start mark keeper whose rewrite fails because the run's directory moved after its check now warns that the directory is no longer the one it started on, and stops. Before, the `PDA_START_MARK` warning said the rewrite failed (ENOENT or ENOTDIR). Nothing is written in either case; only the stated reason changes.
