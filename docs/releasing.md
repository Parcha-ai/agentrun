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

Before creating the release tag:

1. Confirm who will start the workflow. A GitHub App needs **Actions: write** to dispatch or rerun it; repository contents access alone is insufficient. If the App lacks this permission, arrange a maintainer dispatch before starting the release.
2. Confirm who can approve `npm-release`. If **Prevent self-review** is enabled, the person starting the workflow must have a different eligible reviewer. A sole reviewer who also dispatches needs self-review allowed; keep the required review and allowed-tag restrictions.
3. Include any release-script or workflow fixes in the reviewed commit before tagging. A rerun uses the tagged source, not newer fixes on `main`. Never move an existing release tag.

Complete the [public launch checklist](#public-launch) before announcing the release. Review source, repository refs and retained GitHub records before changing visibility. Source export checks do not review issues, pull requests or Actions artifacts.

Create a reviewed beta tag whose version matches every package, such as `v0.1.0-beta.1`. At that exact tag:

```sh
node scripts/release-preflight.mjs --tag v0.1.0-beta.1
```

The preflight checks tag identity, clean source, package versions, licenses and verified archive bytes. A passing check does not authorize publication.

## Publish and verify

Dispatch **Publish verified beta** with the workflow ref and `tag` input set to the same reviewed tag. The workflow requires a public repository, publishes the verified archives with the `beta` tag, and verifies registry integrity and a fresh installed consumer.

An npm publish success can mean the package is still processing. The verifier allows 60 five-second waits for metadata and tarball availability. It still fails immediately on authentication errors or mismatched integrity. Do not treat npm's acceptance message as a completed release.

If publication stops partway, resume from the same tag and archive bytes. The workflow verifies an existing version before skipping it. A byte mismatch stops publication; never replace a published version with different bytes.

If the visibility wait expires, check the exact version in the registry before retrying; it may already be published. Resume only after confirming its bytes match the verified archive. Do not change the version or start a separate publication to work around the delay.

The release is complete only when all three published archives match the release plan and the fresh registry installation passes. Confirm the `beta-release-<run ID>` artifact contains the release plan, archives, and `published-all.json` with `status: passed` and `cleanRegistryInstall: true`. Artifact upload must include the hidden `.release/` directory. If an older workflow omitted the artifact, preserve equivalent verification receipts before reporting completion.

After publication, test the README from an empty clone and exact-version npm installation outside the workspace. Remove private or unpublished notices only when those public paths work. Website deployment belongs to the separate website repository.

See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/) and [scoped package](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) documentation for account setup.

## Public launch

1. Review the release source and make only the DSL repository public. Keep the website repository and any prelaunch history archive private. Verify that an unauthenticated user can clone the source and follow the README.
2. A repository admin must enable **Settings → Advanced Security → Private vulnerability reporting**. GitHub provides this feature only for public repositories. Open the [reporting form](https://github.com/Parcha-ai/agentrun/security/advisories/new) from a signed-in account without repository write access to confirm it works. A maintainer must subscribe to security-alert notifications. See [GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
3. Publish the verified packages in dependency order, then verify a clean registry installation. Until that succeeds, keep the source installation as the default and retain the unpublished-package notices. Previously prepared tarballs are invalid after source changes; rebuild and verify them.
4. Once the registry checks pass, update the package READMEs and changelog with the published version, `beta` install commands and release date. Test those exact commands outside the workspace before announcing them.
