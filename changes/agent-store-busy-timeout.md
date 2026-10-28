---
packages: @parcha/pi-durable-agent
kind: feature
---
**`openStore` and `openStoreReader` take `busyTimeoutMs`**
- `openStore(dir, { busyTimeoutMs })` and `openStoreReader(dir, { busyTimeoutMs })` set how long a call waits synchronously for another connection to let go of the store before it throws SQLite's busy error. The default stays 5000; 0 throws at once, for a host that waits without blocking.
- `createAgent` on a busy store throws SQLite's busy error. Before, it said the agent already exists.
