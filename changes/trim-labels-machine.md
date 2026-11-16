---
packages: @parcha/agentrun-computer
kind: breaking
---
A provider can no longer declare `labels: "machine"`: `HostFacts.labels` takes `{ count, bytes, packed }` only, and `Machine.name`, `Machine.image`, `HostedOptions.image` and the `sweep --image` flag go with it. A vendor with no labels of its own waits for a first provider that needs the mechanism.
