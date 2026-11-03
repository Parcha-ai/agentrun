# Final package proof

Recorded public commit: [`23bf2743349e38461601fd6e959d6801b99df46e`](https://github.com/Parcha-ai/agentrun/commit/23bf2743349e38461601fd6e959d6801b99df46e). This bundle copies existing final receipts; no builds or tests were rerun to assemble it.

| Proof | Recorded result | Evidence |
|---|---|---|
| Shared UI package | Strict Bundler and NodeNext consumers with `skipLibCheck:false` and no repository aliases; public ESM exports and configured API base passed. Archive contains 65 files, including 57 declarations and required notices. | [Consumer log](evidence/ui-consumer.log), [archive inventory](evidence/ui-pack.json), [identity](evidence/ui-identity.json), [sample](evidence/ui-consumer/consumer.tsx), [config](evidence/ui-consumer/tsconfig.json), [recorded commands](evidence/ui-consumer/recorded-commands.txt), [toolchain](evidence/ui-consumer/toolchain.json) |
| Native packages | npm 11.21.0 `verify:packages -- --console` passed for 17 archives, installed runtime/declaration checks and the server's console/notices/manifest. Same head and clean tree before/after. | [Log](evidence/native-packages.log), [head/clean identity](evidence/native-identity.json), [full receipt](evidence/native-verification.json) |
| Public source | Export and downloaded-source consumer passed: 3,097 files, 327 locked runtime package/version pairs, 12 license review flags. Installation used the network; build/demos prohibited Node networking. Expected missing-evidence demos returned exit 2. | [Export receipt](evidence/source-export-receipt.json), [consumer receipt with command outputs](evidence/source-consumer.json), [consumer log](evidence/source-consumer.log), [license flags](evidence/license-review-flags.json) |

UI archive SHA-256: `84d0402939387f8efbb73d88fad5250cb9c9d6c56c4fd9bf5e0519e466ea84e0`. Source archive SHA-256: `1a18de92bd339edaed056047eb488e80dbb20e0c0cc5e71c3554763f0385cd7d`. The archives themselves are not included; inventories and recorded identities are linked above. The [UI manifest](evidence/ui-manifest.json) remains `private:true`.

Passing the native verifier includes accepted audit exceptions: its consumer audit returned exit 1 with **8 moderate, 6 high and 0 critical** findings. Six package entries are accepted until **2026-11-06**; package names and advisory IDs remain in the [audit receipt](evidence/native-audit.json). This is not a zero-findings audit.

The separate console install still reports **14 findings: 7 moderate, 3 high and 4 critical**; remediation is pending ([final-build excerpt](evidence/console-install-audit-excerpt.log)). The 12 license flags also remain review items. The source exporter records `publicationReady:false`; checks do not establish publication rights. No claim of a full repository check or registry publication is made here.

Copies redact machine paths, internal hosts and credential-like values while retaining statuses, public package names, versions, artifact hashes, license flags and audit exceptions. [Bundle manifest](bundle-manifest.json) records original/sanitized evidence digests and redaction counts. Secret scanning is heuristic; scripted/offline consumers do not qualify live provider quality.
