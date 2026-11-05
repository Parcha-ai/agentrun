---
packages: repo
kind: ci
---
The release sets `@parcha/agentrun`'s version; a pull request no longer bumps it. A change to what the `npx @parcha/agentrun` command publishes now adds only a fragment for `@parcha/agentrun`, and `node scripts/changes.mjs --check` refuses a pull request that moves its version. On the release pull request, which moves the command's pin on the server every time, the check still refuses a change to its published files that keeps the version, so each release gives it the next `x.y.z`. Pull requests stop colliding on that number, and the changelog stops naming versions that were never published (0.3.1 to 0.3.3 in beta.29). `docs/releasing.md` says so.
