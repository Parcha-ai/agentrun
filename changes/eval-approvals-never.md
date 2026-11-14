---
packages: @parcha/agentrun-serve
kind: feature
---
`agentrun-serve eval-template` runs its agents with approvals `never`, whatever the package's own `approvals`, so a template whose tools ask by default (a paid data endpoint, say) is measured instead of stopping at its first ask. The package's default is unchanged. The report says how it was measured: `approvals: {measured: "never", package: "ask" | "never"}` in the JSON, and "Measured with approvals never (the package's own default is ask)." in the markdown.
