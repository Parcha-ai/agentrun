---
packages: @parcha/agentrun-computer
kind: feature
---
Browserbase and Kernel are computers of kind `browser` (`src/browserbase.ts`, `src/kernel.ts`), registered in `providers.ts` and held to their `PROVIDERS` entries. Their `CAPABILITIES` are `cdp` and `stream`.

- Each is built by `create(options)` from `apiKey` (Browserbase also takes `projectId`) or from a host's own transport (`api`, `request`). Each calls the vendor's REST API at the same endpoints pi-browser calls today.
- Labels ride the vendor session's metadata. `attach` finds a session by id or by labels, `list` by labels. `connect` gives `cdp.url`, the signed CDP URL, which is a secret. `stream` gives the live view. `release` is idempotent and confirmed by a read-back. `check()` refuses a lifetime past the vendor's cap. Neither has `extend`.
- `testConnection()` makes one read of the account's running sessions or browsers and never creates one.
- The conformance CLI runs the browser case set (health, then `browser.*`) for a provider of kind browser. The set shares one session per run, and `--kind browser` passes on it. The conformance modules read `COMPUTER_BROWSERBASE_*` and `COMPUTER_KERNEL_*` behind a live switch.
- Browserbase refuses a dot in a userMetadata key, as found live. A label's dots are written there as `_` and read back as dots, and `check()` takes Browserbase label keys of letters, digits and dots only, with no `'` or `\` in a value.
