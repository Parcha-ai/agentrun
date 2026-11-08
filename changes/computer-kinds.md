---
packages: @parcha/agentrun-computer
kind: feature
---
An agent's computer is a kind: `none`, `sandbox`, `desktop`, `phone` or `browser` (`src/kinds.ts`). `KIND_SPECS` gives each kind's plane, its required and optional capability groups (the protocol's own), the protocol kinds that may serve it, and the tools a loop gets for it. `KIND_PROVIDERS` names the provider ids that offer each kind: sandbox is Docker, E2B, Daytona and Modal; desktop is Docker's and E2B's desktops. `serves`, `servingRefusals`, `kindOf` and `toolsFor` are computed from a provider's capabilities, so a provider that drops a group stops serving its kind.

Conformance runs by kind: `--kind <kind>` (`kind` in `runConformance`) runs `kindCases(kind)`. A provider passes the kind (`report.kindVerdict`, exit 0) only when it serves the kind and every case of each required group passes. `kindCases` and `kindVerdict` are exported for the serve side.
