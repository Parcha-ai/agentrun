---
packages: repo
kind: ci
---
`docs/dependencies.md` no longer carries the lockfile's SHA-256, so two pull requests that both touch `package-lock.json` no longer conflict on that one line when the lock itself merges clean. The inventory is generated from the locked runtime graph alone: a change to a development-only entry leaves it byte for byte. The lock's hash stays in the source export's receipt (`packageLockSha256`), and `node scripts/check-generated.mjs` still fails a committed inventory that does not match the lock it was generated from.
