---
packages: @parcha/agentrun-computer
kind: breaking
---
A vendor on the shared machine-host adapter declares its label byte budget instead of writing it. `HostFacts.labelRules` takes `maxBytes` and `measure` (`"pairs"`, every name and value, the default; or `"json"`, the labels as one JSON object), and the adapter's `check()` prices the caller's labels with its own at their longest, refusing past the bound in words (field `mount` for an Archil computer, else `labels`). Modal (512 bytes, pairs) and Agent37 (4096 bytes, json) declare theirs and drop their own counting; `tagsOf` and `labelsOf` are gone from `dist/modal.js`.
- Breaking: an Archil computer's `agentrun.mount` label now records `{ kind, disk, region, agent }`, where `agent` is the folder's agent: the folder's run is the `agentrun.run` label's. A computer made before this change carries the folder whole, so the provider reads its mount as one it never makes: delete it at the vendor.
