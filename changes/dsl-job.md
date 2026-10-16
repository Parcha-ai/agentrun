---
packages: @parcha/agentrun-dsl
kind: feature
---
`@parcha/agentrun-dsl` exports `Job`, `{ workflow: Workflow; input: Record<string, unknown>; files?: Record<string, Uint8Array> }`, the shape a host passes when it runs a workflow with the input and files it starts with, and `defineJob(job)`, an identity that checks that shape and keeps the workflow's literal type (a workflow declared `as const satisfies Workflow` flows through). New public exports; no behavior or stored format changes.
