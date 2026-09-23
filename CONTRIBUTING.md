# Contributing

Use Node 22.19+ and npm. From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm run verify:packages
```

Tests use scripted adapters and must not require model credentials. Package verification installs built tarballs into a separate application and needs network access to download dependencies. Live examples are opt-in.

Keep provider configuration and application policy outside the interpreter. Integrate through `runNode`, `runJudge`, or `runEffect`. For a behavior change, add a test that reproduces the failure and checks the result a caller depends on. Keep expected outcomes independent of the implementation. Mock external services at adapter boundaries.

Document breaking changes and failure behavior. After changing workflow types, regenerate the editor schema with `node scripts/generate-schema.mjs`. For installation or packaging changes, also run `npm run export:source` and `npm run verify:source`. The source verifier builds the exported archive in an empty directory and exercises the offline examples.

## Changing workflow behavior

The optional [Lean specification](spec/lean/README.md) is a contributor tool for checking selected execution rules. It is not a runtime dependency. Its proofs apply to the model under stated assumptions; shared tests check agreement with TypeScript on a finite set of cases, not equivalence for every workflow.

When changing validation, state paths, branch merges, loops, or desugaring:

1. Add a TypeScript regression test with an independently chosen expected result.
2. Check whether the change affects the model or its assumptions. Update the Lean definitions and proofs when it does, and add a shared conformance case where applicable.
3. Install [elan](https://github.com/leanprover/elan), then run these checks after `npm run build`:

```sh
node --test packages/dsl/test/lean-conformance.test.mjs packages/dsl/test/lean-findings.test.mjs
node spec/lean/sweep/collect.mjs spec/lean/.lake/validator-corpus.json
cd spec/lean
lake build
lake exe conformance
lake exe validator-sweep .lake/validator-corpus.json
```

`lake build` checks the proofs and their assumptions. Conformance cases compare execution results; the sweep checks that workflows accepted by TypeScript in the collected corpus are also accepted by the model. Review expected-result changes before accepting them. Do not update fixtures merely to make a changed implementation pass.

The [findings table](spec/lean/README.md#findings) distinguishes runtime fixes, validation gaps, and documented limits. Documentation-only changes do not require installing Lean. CI runs the Lean checks separately from `npm run check`.

The website is maintained separately in a private repository. Send website feedback through this repository's [issues](https://github.com/Parcha-ai/agentrun/issues). Documentation illustrations in this repository have their own [asset instructions](docs/assets/README.md).

Code and documentation use Apache-2.0. Unless you explicitly state otherwise, contributions submitted for inclusion use that license. Preserve third-party notices. This repository requires no separate contribution licensing agreement.
