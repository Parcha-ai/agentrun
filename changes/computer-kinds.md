---
packages: @parcha/agentrun-computer
kind: feature
---
An agent's computer is a setting kind: `none`, `sandbox`, `desktop`, `phone` or `browser` (`src/kinds.ts`). `SETTING_KINDS` gives each kind its machine kinds and its required and optional capability groups, and carries no tool names. `serves`, `servingRefusals` and `kindOf` are computed from a provider's capabilities, so a provider that drops a group stops serving the kind. `PROVIDERS` is what Settings offers. Each entry holds an id, a label, the serve-side key names (required or not), mounts, whether the vendor meters, and static capabilities, and its kinds are derived from those. Orgo, phone-harness, Browserbase and Kernel are data until their provider files land. Each provider module exports `CAPABILITIES`, which must match its entry.

- The protocol gains the machine kind `browser` (os linux, daemon none, Core group `cdp`), and the groups `cdp`, `stream` and `downloads`, which belong to the provider and never appear in a computerd hello. `ComputerConnection.cdp?: { url }` carries a browser's CDP target as a secret. `ComputerErrorCode` gains `unauthorized` and `unreachable`.
- `testConnection()` on a provider makes one account-level read that never creates a computer. Docker, Daytona, E2B and Modal implement it: the first three list by their own label, and Modal reads its app without creating it. It answers `unauthorized` for a key the vendor refused.
- Conformance runs by kind: `--kind <kind>` (`kind` in `runConformance`) runs `kindCases(kind)`. A provider passes the kind (`report.kindVerdict`, exit 0) only when it serves the kind and every case of each required group passes. `kindCases` and `kindVerdict` are exported for the serve side.
