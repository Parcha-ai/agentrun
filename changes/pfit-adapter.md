---
packages: @parcha/agentrun-computer
kind: feature
---
The shared machine-host adapter fits vendors whose labels, names and logins differ from E2B's, with no new option.
- A label codec (`packLabels` and `unpackLabels` in `hosted/values.ts`) stores a machine's whole label map in what a vendor has: a cap of 5 tags, Kubernetes' label values, 16-byte names, or a list of strings. A host that packs sets `HostFacts.labels.packed` (with `valueBytes`, the most one value holds), and `check()` refuses a spec whose labels can't fit, in words, before any call.
- A create that the vendor refuses because a machine already has the name (409, `exists`) now adopts that machine, as a retry does, instead of failing. The REST client's `named` call reads a 409 as `exists`. Daytona's create uses it.
- SSH exec moves to `hosted/ssh-exec.ts`. The host gives the login for each machine (Agent37 gives root and its key), and every error it throws has the key, the password and any secret in the username taken out.
