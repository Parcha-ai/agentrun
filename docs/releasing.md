# Release a beta

The packages are `@parcha/agentrun-dsl`, `@parcha/agentrun-jev`, and `@parcha/agentrun-pi`. They share a version and must be published in that order. Publication is manual; pushes, pull requests and tags do not publish packages.

## Verify the source and packages

Use Node 22.23.2 and GNU tar for release verification. From a clean checkout:

```sh
npm ci --ignore-scripts
npm run check
npm run export:source
node scripts/check-generated.mjs
npm run verify:packages
npm run verify:source
```

Inspect `.release/verification.json` and `.release/source-consumer.json`. Package verification installs the exact tarballs into an empty consumer. Source verification checks the archive against its export receipt, then extracts, installs, builds and exercises its offline examples. Dependency installation requires network access.

Regenerate schemas, packaged demo data and the dependency inventory when their sources change. Verify that LICENSE, NOTICE and applicable asset notices accompany the source and package archives. Offline checks establish execution behavior; live adapter compatibility needs a separate configured check.

## Prepare publication

Confirm publishing access to the `@parcha` npm organization. New packages need an initial authenticated publication before a trusted publisher can be associated with them. Arrange that bootstrap with the package owner; the release workflow does not create accounts, grant ownership or complete this first-publication setup. The existing `@parcha/agentrun` package is separate.

Once each package exists, configure its trusted publisher for this repository's `release.yml` workflow. This workflow publishes directly, so the association must allow direct publishing. Configure the `npm-release` GitHub environment with maintainer review and allowed tags. Subsequent workflow releases use OIDC and provenance. See [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) for publisher configuration.

Before a public release, configure and test private vulnerability reporting and update [SECURITY.md](../SECURITY.md). Review the source, repository refs and retained GitHub records before changing visibility. Source export checks do not review issues, pull requests or Actions artifacts.

Create a reviewed beta tag whose version matches every package, such as `v0.1.0-beta.1`. At that exact tag:

```sh
node scripts/release-preflight.mjs --tag v0.1.0-beta.1
```

The preflight checks tag identity, clean source, package versions, licenses and verified archive bytes. A passing check does not authorize publication.

## Publish and verify

Dispatch **Publish verified beta** with the workflow ref and `tag` input set to the same reviewed tag. The workflow requires a public repository, publishes the verified archives with the `beta` tag, and verifies registry integrity and a fresh installed consumer.

If publication stops partway, resume from the same tag and archive bytes. The workflow verifies an existing version before skipping it. A byte mismatch stops publication; never replace a published version with different bytes.

After publication, test the README from an empty clone and exact-version npm installation outside the workspace. Remove private or unpublished notices only when those public paths work. Website deployment belongs to the separate website repository.

See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/) and [scoped package](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) documentation for account setup.
