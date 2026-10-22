---
packages: @parcha/pi-durable-disk
kind: feature
---
`boxHost({ provider, spec, app, ... })`, on the new entry `@parcha/pi-durable-disk/box`, is a host driver over the boxes of any pi-transport provider, Modal's VM first. A start finds the box its attempt made (its labels) or creates one with `capabilities: ["fuse"]`, refuses a box that cannot hold the run's mount before any upload or launch (`UNSUPPORTED`, remembered for the spec, so ensureRunning's ticks don't boot and destroy a box each time), and has transport's launcher keep the CLI running as root with `--run-as <runAs>` (default `pda`, never root): the instance, the launcher and the FUSE daemon hold the mount token, and every agent command runs as `runAs` with no capabilities, so none can trace a holder, with or without Yama. The token rides the launch's stdin only, and nothing goes through sudo. A running launch found again is adopted; an ended or lost one is replaced, never relaunched, and `status` reports a lost launch `failed`. `box(handle)` gives facts-only receipts. Errors are `BoxHostError`.
- Packaging: `@parcha/pi-transport` is an optional peer, needed by `./box` only; the root entry does not depend on it.
