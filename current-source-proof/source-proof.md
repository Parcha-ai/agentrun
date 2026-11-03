# Current source proof

Recorded public commit: [`cf668bea326996da873c755bab7dbc3e356932aa`](https://github.com/Parcha-ai/agentrun/commit/cf668bea326996da873c755bab7dbc3e356932aa). The fresh source export and downloaded-source consumer both passed: **3,098 files, 327 locked runtime package/version pairs and 12 license review flags**.

- [Source export receipt and complete file/dependency inventories](evidence/source-export-receipt.json)
- [Consumer receipt with recorded commands, outputs and exit codes](evidence/source-consumer.json)
- [Consumer completion log](evidence/source-consumer.log)
- [Archive and current-head identity](evidence/source-identity.json)

Archive SHA-256: `2985cb4d3962ea4f0a11c0a3c9a8b1e6e3e1ceea3bdd418855b6b306a44d1e92`. Source tree SHA-256: `e4a54a830e393043fa78c6c3e2cb2f908a2ac6e429a97e27ea18d877c051dc89`. The archive itself is not included.

The recorded consumer installed the export, built it, ran scripted demonstrations, exported/inspected the ten-node graph and verified native Pi discovery and skill expansion. Installation used the network; build/demos prohibited Node networking. Missing-evidence scenarios returned the expected exit 2.

The [preservation comparison](evidence/production-preservation.json) records that production source, manifests, dependency locks, build inputs, UI and exported declarations match previously proved commit `23bf2743`; the intervening diff contains server tests and one changelog fragment. The separate historical package bundle remains unchanged and keeps its original 3,097-file source count.

The exporter still records **`publicationReady:false`**. All [12 license flags](evidence/license-review-flags.json) remain release-owner review items. Source usability checks do not establish publication rights, live-provider quality or absence of every secret.

This bundle copies existing receipts with machine paths, internal hosts and credential-like values redacted. [Bundle manifest](bundle-manifest.json) records original/copied hashes and redaction counts. No tests, builds, installs, source edits, publication or PR mutations occurred while assembling it.
