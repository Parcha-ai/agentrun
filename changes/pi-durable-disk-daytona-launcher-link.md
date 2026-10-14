---
packages: @parcha/pi-durable-disk
kind: fix
---
`daytonaHost`'s in-box launcher runs when its path goes through a link. It ran its main only when `process.argv[1]` resolved to its own module path, which Node gives with links followed, so under a symlinked package directory (pnpm-style linked `node_modules`, or a link to an installed package) it exited 0 without doing anything and every start failed with "the instance ... did not start: " and no reason. It now compares the real path. And when the launcher gives no reason, the driver's error carries what it printed (its last 4 KB) or says it printed nothing; it prints only its state, never the token.
