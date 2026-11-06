---
packages: @parcha/agentrun-computer
kind: feature
---
A conformance suite for computer providers: `npm run conformance -w @parcha/agentrun-computer -- --provider docker` (or `--provider ./module.js`, a module that exports `createProvider()`) runs every case against the provider, prints one line per level and group with each failure's reason, and exits 0 when Core passes, 1 when it fails and 2 on a usage error; `--json` prints the report.
- Each case is data: an id, a level (`core` or `full`, after the Kubernetes agent-sandbox conformance levels), a group (`health`, `exec`, `files`, `process`, `provider`, `drift`) and the capabilities it needs. A case whose needs the provider or its daemon does not declare is skipped with the reason, never failed; Core passes only when every Core case passes.
- Cases assume no root: a computer's programs run as the provider's non-root default with no capabilities, and the suite works under the computer's `HOME`. `capabilities().user` (`["root", "uid"]` for Docker) declares which `spec.user` requests a provider takes; the Full cases `exec.root-on-request` and `exec.user-uid` need `user:root` and `user:uid`.
- `runConformance(provider, { image, only?, signal?, drifted? })` and `formatReport(report)` run it from code. The run labels every computer it makes, deletes each one, sweeps its label when the provider's lifetime is `"janitor"`, and reports any computer left.
- `npm run test:docker` runs the suite on Docker, one test per case, and the CLI against `alpine:3.20`; the Docker live tests keep only what Docker alone shows.
