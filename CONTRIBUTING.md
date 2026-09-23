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

Website changes belong in [agentrun-website](https://github.com/Parcha-ai/agentrun-website). Documentation illustrations in this repository have their own [asset instructions](docs/assets/README.md).

Code and documentation use Apache-2.0. Unless you explicitly state otherwise, contributions submitted for inclusion use that license. Preserve third-party notices. This repository requires no separate contribution licensing agreement.
