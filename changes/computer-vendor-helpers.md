---
packages: @parcha/agentrun-computer
kind: fix
---
The four hosted computer providers (E2B, Modal, Agent37, Daytona) share more of their plumbing through the adapter, with no change to what a computer does. A host's `get` or `delete` that fails with `not_found` is read by the adapter as a machine that is gone, so no vendor catches it any more; the adapter reads an `AbortError` as `aborted` and a `TimeoutError` as `timeout` itself, so `MachineHost.errorCode` is optional (a host that leaves it out answers `vendor` for the rest); a process's output streams are Node `PassThrough` streams (a log stream that fails now ends its readers at once with the error, where Daytona's kept the output already read until it was consumed); and the whole-number, drift, date and size readings and the abort-or-timeout bound are one copy under `hosted/`.
