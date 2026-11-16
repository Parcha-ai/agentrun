---
packages: @parcha/agentrun-computer
kind: feature
---
The conformance kit takes `--concurrency <n>` (`concurrency` in `runConformance`'s options) for a vendor plan that keeps few machines at once: a create waits for a computer to be released, the run's own computer makes way for a case that doesn't use it, and a case that needs more than `n` at once fails in words. Every report says the most computers the run had alive at once (`computers: { peak, cap? }`, and a `computers alive at once` line).
- The hosted adapter's wait for the listing to show a new machine backs off from 150 ms to the host's `pollMs`, so a vendor slow to list costs a few listings (13 for a machine listed 10 s late at `pollMs` 2 s, down from 78), and a vendor with an hourly request limit raises `pollMs`.
- `PROVIDERS.md` and `spec/computer/provider.md`: a value that isn't secret but has no default for everyone (a server URL, a project or workspace id) is a key with `required: true`, since Settings fills keys and passes only a setting's `default`.
