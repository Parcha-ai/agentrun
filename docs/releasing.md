# Release a beta

The packages are `@parcha/agentrun-dsl`, `@parcha/agentrun-jev`, `@parcha/pi-browser`, `@parcha/agentrun-import`, `@parcha/agentrun-web`, `@parcha/agentrun-decisions`, `@parcha/agentrun-computer`, `@parcha/agentrun-client`, `@parcha/agentrun-kernel`, `@parcha/agentrun-harness-claude`, `@parcha/agentrun-harness-codex`, `@parcha/agentrun-harness-acp` and `@parcha/agentrun-serve`. They share a version and are published in that order (`pi-browser`, `agentrun-import`, `agentrun-web`, `agentrun-computer` and `agentrun-client` depend on none of the others; `agentrun-jev`, `agentrun-decisions` and `agentrun-kernel` depend on `dsl`, `agentrun-harness-claude` and `agentrun-harness-codex` on `dsl` and `agentrun-kernel`, `agentrun-harness-acp` on `agentrun-kernel`, and `agentrun-serve` on `dsl`, `jev`, `pi-browser`, `agentrun-import`, `agentrun-web`, `agentrun-decisions`, `agentrun-computer`, the kernel and the three harnesses). `@parcha/agentrun`, the `npx @parcha/agentrun` command, is published after the server it depends on, at a version of its own; see [The command's own version line](#the-commands-own-version-line). Publication is manual; pushes, pull requests and tags do not publish packages.

## The command's own version line

`@parcha/agentrun`, the `npx @parcha/agentrun` command (`packages/agentrun`), is published by every release but not at the workspace version: it has a version line of its own, from 0.3.0, above the 0.2.x that the hosted API's TypeScript SDK published under the same name from its own repository. `ownVersionPackages` in `scripts/changes.mjs` names it; the release preflight checks it at its manifest's version, a plain `x.y.z`, and it is published in the layer after `@parcha/agentrun-serve`'s, the last to go out.

- **The release sets its version, and every release moves it.** Its manifest pins the server at the release version, so the release pull request moves both: the pin to the new workspace version and the command to its next `x.y.z`. A pull request that changes what it publishes (its manifest, `bin/`, `lib/`, README, LICENSE or NOTICE) leaves the version alone and adds a fragment for `@parcha/agentrun`; the release's changelog names the version that ships. `node scripts/changes.mjs --check`, which CI runs on every pull request, refuses a pull request that moves the version, and a release commit that changes those files and keeps it. A version bump of it alone is not a release commit.
- **A release resumes or stops on it, after the server.** The release probes it before publishing it: a version already on npm with the same bytes is verified and skipped, as for any package; one with other bytes stops the release there, after the other packages are published, and the fix is a version bump. `changes --check` refuses that on the release pull request first.
- **It runs the server it was released with.** `@parcha/agentrun-serve` is its one dependency, at the release's exact version (`release-preflight` refuses any other), so `npx @parcha/agentrun@<version>` always installs the same server, and its version line says which. Until the server of a release is on npm, that release's command cannot be installed, so it is published after it.
- **`latest` must stay on it.** `npx @parcha/agentrun` runs what the `latest` tag names. A publish of the SDK from its own repository must use another tag (for example `npm publish --tag sdk`), or `latest` moves back to 0.2.x and the command loses its bin.

## The Python client's own version line

`parcha-agentrun`, the Python client (`python/`), is published to PyPI by the release's `pypi` job, from the same tag, beside the npm packages and under the same approval. It depends on none of them, so it does not wait for them. Its version is a line of its own, `python/pyproject.toml`'s, from 0.3.0: PyPI already holds 0.2.0 and 0.2.1 under that name from the old hosted SDK, and pip installs the highest version, so the client starts above them and is never at the npm `0.1.0-beta` line.

- **Plain releases only.** The version is a canonical `x.y.z`, as `@parcha/agentrun`'s is, never a pre-release such as `0.3.0b1`: pip passes over a pre-release unless asked for `--pre`, so one would leave `pip install parcha-agentrun` on 0.2.1. `python/agentrun/__init__.py`'s `__version__` says the same version.
- **The release sets it, as it sets the command's.** A pull request that changes what the client publishes (`pyproject.toml`, `README.md`, `LICENSE`, `NOTICE` or `agentrun/`) leaves the version alone; the release pull request moves it to its next `x.y.z` when the client changed since the last release. `node scripts/changes.mjs --check` refuses a pull request that moves it, and a release commit that keeps it while those files differ from the last release tag's (the newest `v*` reachable from it), however many pull requests ago they changed.
- **The release checks before it uploads.** The job builds the sdist and wheel with `python -m build`, then `node scripts/python-release.mjs --verify` checks the project (name, version line, no `Private :: Do Not Upload` classifier, the root `LICENSE` and `NOTICE` beside it), the two archives against this tree's `python/` file for file, the wheel's packaged `LICENSE` and `NOTICE` against the root's, `twine check --strict`, and the wheel installed in a clean venv whose smoke runs with every connection refused. It writes the archives' SHA-256 to `.release/python-plan.json`, kept with the archives as the job's artifact. `--on-pypi DIST` then asks PyPI for the version: absent, it is uploaded; present, its wheel is fetched over https, checked against PyPI's SHA-256, and compared with the build's `agentrun/` files. The same contents are not uploaded again, so a re-run publishes nothing twice; other contents stop the job (bump the version); a network failure stops it too, never read as a skip.
- **The check runs anywhere, and uploads nothing.** With `build` and `twine` in a Python 3.10 or newer: `python -m build --sdist --wheel --outdir /tmp/python-dist python` and `node scripts/python-release.mjs --verify /tmp/python-dist --python python`. Only the workflow's trusted-publishing step uploads.

## Held packages

The packages a release may publish are named, in publication order, in `releasePackageNames` in `scripts/release-preflight.mjs`: dependencies first (`dsl`, then `jev`), then the packages that depend on none of them (`pi-browser`, `import`, `@parcha/agentrun-import`, the session readers `serve` uses, and `web`, `@parcha/agentrun-web`, its web search and fetch), `decisions` (`@parcha/agentrun-decisions`), which uses `dsl`, `computer` (`@parcha/agentrun-computer`), which uses none, the harness kernel (`@parcha/agentrun-kernel`), which uses `dsl`, and the harnesses on it (`@parcha/agentrun-harness-claude` and `@parcha/agentrun-harness-codex`, which use `dsl` and the kernel, and `@parcha/agentrun-harness-acp`, which uses the kernel), `serve` (`@parcha/agentrun-serve`), which uses `dsl`, `jev`, `pi-browser`, `import`, `web`, `decisions`, `computer`, the kernel and the harnesses, and the command (`@parcha/agentrun`), which uses `serve`, last. That list is the gate for a new package: `release-preflight` fails when a workspace package is neither private nor named there, so a package is never published by accident. A package whose manifest says `"private": true` is held. It is built, tested, typechecked and checked by `verify-packages` and `verify:tarball`, and it is bumped with the workspace version in every release PR like the rest (`release-preflight` fails if its version differs from the workspace's), but it is skipped at publication: the publish set (`releasePackages`, which `verify-published` and the workflow's publish loop read) is the named packages that are not held. Lifting a hold is one commit that removes `"private": true` from the package's manifest, after its npm bootstrap and trusted publisher exist (see "Prepare publication").

## Verify the source and packages

Use Node 24.22.3, npm 11.21.0 and GNU tar for release verification. From a clean checkout:

```sh
npm install --global npm@11.21.0 --ignore-scripts
npm ci --ignore-scripts
npm run check
npm run build:daemon -w @parcha/agentrun-computer
npm run export:source
node scripts/check-generated.mjs
npm run verify:packages -- --console
npm run verify:source
```

`npm run check` builds first, and the root build builds the console before the workspaces (`scripts/build-console.mjs`), so the server's build copies it into the archive `@parcha/agentrun-serve` publishes, with `THIRD-PARTY-NOTICES.txt`: the console's Vite build writes that file from the bundle's own module list (each bundled package, its version, its license and its license text), and the server's `NOTICE` points to it. `--console` stops verification when the server's archive lacks either. `npm run build:daemon -w @parcha/agentrun-computer` needs Go (the version `packages/computer/daemon/go.mod` names, or newer) and writes the daemon binaries `@parcha/agentrun-computer` publishes, `dist/computerd-linux-amd64` and `-arm64`; verification stops when its archive lacks either, or holds one built for another version. The release workflow runs the same steps.

The console's Vite build also fails when what it would ship looks like it holds a credential (`apps/console/credential-gate.mjs`). It reads every emitted script and text file, `THIRD-PARTY-NOTICES.txt` and `index.html` included, and stops on a private key, a GitHub, OpenAI, Anthropic, Slack or AWS key, a JWT, or a URL with a password in it. It also stops when the bundle took in a test, fixture, sample, mock or story from `apps/console/src`. The error names the file but never the text it matched, and hides a file name that itself looks like a credential. Storybook's build is not shipped and skips this check.

Inspect `.release/verification.json` and `.release/source-consumer.json`. Package verification installs the exact tarballs into an empty consumer. Source verification checks the archive against its export receipt, then extracts, installs, builds and exercises its offline examples. Dependency installation requires network access.

Regenerate schemas, packaged demo data and the dependency inventory when their sources change. Verify that LICENSE, NOTICE and applicable asset notices accompany the source and package archives. Offline checks establish execution behavior; live adapter compatibility needs a separate configured check.

## Prepare publication

The eve extension (`@parcha/agentrun-eve`) is listed in the release plan and clean-package checks,
but remains held with `private: true` until its npm bootstrap and trusted publisher are configured.
Its runtime dependencies include the matching client and DSL, so dependency layering publishes it
after both once the hold is lifted. The package verifier additionally mounts the exact archives in
an isolated eve application, typechecks it and builds production output without application-level
build overrides. Keep the candidate's unpublished status explicit until registry verification passes.

Confirm publishing access to the `@parcha` npm organization. New packages need an initial authenticated publication before a trusted publisher can be associated with them. Arrange that bootstrap with the package owner; the release workflow does not create accounts, grant ownership or complete this first-publication setup. `@parcha/agentrun-serve`, `@parcha/agentrun-import`, `@parcha/agentrun-web`, `@parcha/agentrun-decisions`, `@parcha/agentrun-computer` and `@parcha/agentrun-harness-acp` are new in the publish set: each needs that bootstrap and its trusted publisher before the first release that publishes it. `release-preflight` enforces it: before an archive is checked, it asks npm (`npm view <name> version`) for every package in the publish set (`releasePackages`, held packages excluded) and stops the release, naming each package npm does not have yet, so no release stops halfway through its layers. An npm failure that is not a 404 (network, auth) stops it too; a package is never taken for published without npm's answer. The existing `@parcha/agentrun` package is separate.

Once each package exists, configure its trusted publisher for this repository's `release.yml` workflow. This workflow publishes directly, so the association must allow direct publishing. Configure the `npm-release` GitHub environment with maintainer review and allowed tags. Subsequent workflow releases use OIDC and provenance. See [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) for publisher configuration.

On PyPI, add a trusted publisher to the `parcha-agentrun` project (Manage, Publishing): owner `Parcha-ai`, repository `agentrun`, workflow `release.yml`, environment `npm-release`, the same approved environment the npm packages publish from. The job holds no token or secret; PyPI accepts its upload only from that workflow and environment. See [PyPI trusted publishers](https://docs.pypi.org/trusted-publishers/).

Before creating the release tag:

1. Confirm who will start the workflow. Anyone with write access to the repository may dispatch it: the workflow checks the version and CI itself, and names no person. A GitHub App needs **Actions: write** to dispatch or rerun it; repository contents access alone is insufficient. If the App lacks this permission, arrange a maintainer dispatch before starting the release.
2. Confirm who can approve `npm-release`. If **Prevent self-review** is enabled, the person starting the workflow must have a different eligible reviewer. A sole reviewer who also dispatches needs self-review allowed; keep the required review and allowed-tag restrictions.
3. Include any release-script or workflow fixes in the reviewed commit before tagging. A rerun uses the tagged source, not newer fixes on `main`. Release tags cannot be moved or deleted, so a tag on the wrong commit costs that version number: run the preflight at a local tag in a clean checkout before pushing the tag.

Complete the [public launch checklist](#public-launch) before announcing the release. Review source, repository refs and retained GitHub records before changing visibility. Source export checks do not review issues, pull requests or Actions artifacts.

### The changelog fold

The release pull request bumps the versions and folds the changelogs with one command: `node scripts/changes.mjs --fold 0.1.0-beta.1 --date 2026-10-20` (the date defaults to the date the root `CHANGELOG.md` already gives that version, else today, UTC). In the root `CHANGELOG.md`, and in each package changelog that has fragments, it renames the `Unreleased` section `## 0.1.0-beta.1 (2026-10-20)`, keeping its bullets and adding the fragments' bullets after them, and opens a new empty `Unreleased` section above it. A `breaking` fragment's bullet goes under the section's `**Breaking:**` heading, at the end of that block: the fold opens the heading at the top of a section that has none, with what the section holds under `**Changes:**`, and adds to the one a release pull request wrote. Every fold does this, the release workflow's at the tag included, so the release page shows a breaking change under its heading. Every bullet the fold writes ends its first line with its fragment's marker, an HTML comment naming the file: `- What changed. <!-- changes/what-changed.md -->`. GitHub and the website hide it, and the release notes take it out. A fragment goes to its package's own changelog, else the root; a package changelog with no fragment is untouched. A held package's changelog is never dated: its fragments join its `Unreleased` section. It deletes the fragments. Commit the result with the version bump. Fetch the release tags first (`git fetch --tags`), for the reason below.

A release is its tag's tree, and the tag goes on the release pull request's merge commit. The merge queue can put other pull requests ahead of the release pull request, after its fold (beta.33 had five), so their code is in the tag and their fragments sit in `changes/` there, unfolded. The release does not wait for them or refold:

1. **At the tag, the release workflow folds what the tag carries.** Once the daemon is built, it runs `node scripts/changes.mjs --fold <version>` on the checkout, before anything is packed (after the build, since Go records a modified tree in the daemon's build info as `+dirty`, and nothing built reads a changelog): those fragments go into the version's sections (the root's already exists, so they follow its bullets; a package changelog without one gets it, under the release pull request's date). Nothing is committed, so the tag stays as reviewed; the archives' changelogs list everything the archives ship.
2. **The preflight checks that fold.** `release-preflight` refuses a working tree that is anything but the tag plus the fold: only the tag's fragments may be deleted and only changelogs changed, and every changelog must be exactly what the fold of the tag's fragments writes, which it recomputes from the tag's own files. A hand edit at release time, or a fold of another version, stops the release.
3. **The next release pull request's fold puts them on main.** A fragment that the previous release's tag (the newest `v*` tag reachable from `HEAD`, other than the version being folded) carried with the same text shipped in that release, so `--fold` puts its bullet into that release's section, under that release's date, and never into the new one. A package changelog without that section gets one, below the new version's. The fold prints which fragments it moved. Main's changelogs then say for each release what its archives said. Until then, main's `CHANGELOG.md` lacks those bullets and `changes/` still holds their fragments. A section holds a fragment when it carries that fragment's marker, whatever its words: the fold then adds nothing for it there, also when a pull request deleted the fragment. The bullet's words without the marker hold nothing.

**Curating a carried bullet by hand.** To rewrite what a fold wrote into a release's section (a late fragment's raw bullet replaced by the line the release page used, say), edit the words and keep the marker: at the end of the entry's first line, or anywhere in the entry. One entry that tells two fragments carries both markers (`<!-- changes/a.md --> <!-- changes/b.md -->`). Deleting the marker with the words, or writing the line without it, makes the next fold add the fragment's raw bullet back beside it while the previous tag still carries the fragment.

A fragment added after the tag is the next release's like any other. `node scripts/changes.mjs --check`, which CI runs on every pull request and in the merge queue, refuses an edit of an `Unreleased` section; it does not refuse fragments beside a release commit (one where a workspace `package.json` version differs from the merge base's, other than a package catching up to the workspace version the base already holds), and it still applies the version-line rules below to one.

Create a reviewed beta tag whose version matches every package, such as `v0.1.0-beta.1`. At that exact tag, in a clean checkout, the release workflow's fold and then the preflight:

```sh
node scripts/changes.mjs --fold 0.1.0-beta.1
node scripts/release-preflight.mjs --tag v0.1.0-beta.1
```

The preflight checks tag identity, that the source is the tag plus the changelog fold, package versions, licenses and verified archive bytes. A passing check does not authorize publication.

## Publish and verify

Dispatch **Publish verified beta** with the workflow ref and `tag` input set to the same reviewed tag, after `ci.yml` has finished on the tagged commit's push to `main`. Its `gate` job checks two things before anything is approved or built. The tag must be newer than npm's `latest` for `@parcha/agentrun-serve` and than the newest GitHub release, in semver order (beta.9 < beta.10 < 0.1.0), and it must be the version every workspace `package.json` at the tag says (`scripts/release-version.mjs`); a tag equal to or older than either stops in one line naming both. A release that stopped partway is finished by re-running its failed jobs, not by a new dispatch, which the published version would stop. The workflow does not run the suites again: it requires `ci.yml`'s push run on `main` of exactly the tagged commit (not a merge-queue or pull request run) to have concluded every check `main`'s ruleset requires (`verify` and `lean`) with success, reading them from the ruleset (`scripts/release-ci-gate.mjs`), and stops if the run is missing, still running or red. Jobs that are not required do not stop a release. It then builds and runs the checks that make the archives, requires a public repository, publishes the verified archives with the `latest` tag in dependency order, every layer back to back, then verifies every published package against the registry at once, and verifies registry integrity and a fresh installed consumer. npm accepts a package whose dependencies it does not show yet, so the release waits for the registry once, as long as its slowest package, instead of once per layer (beta.41 waited five times, 39 minutes in all; its slowest single package took under 10). A registry probe that is not an authoritative 404, or a failed publish, stops publishing there: the packages published before it are still verified, so their receipts say what the registry holds, and the run fails. Until every package is visible, which takes up to about 10 minutes, an install of a package whose dependency npm does not show yet can fail; the release is complete only when the clean installation passes. A version is published as `latest` because npm's package page shows the README of the publish that carried the `latest` tag; moving `latest` later with `npm dist-tag` leaves the page without one. The install commands in the READMEs and docs name `@latest`, so a release needs no step after the run for them to install it.

The `beta` dist-tag is kept only for older links that name `@beta`, and the workflow does not move it: it publishes as a trusted publisher, which can publish but cannot run `npm dist-tag`. To bring it up to a release, a maintainer with npm rights runs `npm dist-tag add <name>@<version> beta` once for each published package, with that release's version. It is optional; nothing in this repository installs `@beta`.

An npm publish success can mean the package is still processing. The verifier waits up to 20 minutes in each of three phases: for a version's registry document to appear, for its tarball to download, and for npm to list every release version in both the full and the abbreviated (install) metadata. It polls every 5 seconds at first and backs off to every 30. npm took about 5 minutes to show beta.10 and 16 for beta.11's first package; the job's own limit is 90 minutes, and a rerun on the same tag resumes. Only then does it run its one clean installation. It still fails immediately on authentication errors or mismatched integrity. Do not treat npm's acceptance message as a completed release.

A run whose first attempt fails has its failed and cancelled jobs re-run once, by `release-retry.yml` (the npm-release approval asks again); a second attempt is never re-run. It re-runs only a release dispatched at a beta tag and `ci.yml` on a push to `main`, each with its head in this repository, never a pull request (a fork's included) or the merge queue. A cancelled run is re-run only when `pypi-watchdog` cancelled it, so cancelling a release by hand stops it: nothing re-runs it. The watchdog starts once `publish` has passed. It cancels the run only when `pypi` has been queued for 15 minutes since the approval (read from the jobs API), `publish` has completed with success, and every other job but those that wait for `pypi` has finished: GitHub cancels a whole run, never one job, so the cancel stops `pypi` alone. In any other state it cancels nothing and says why when its time is up. The `pypi` job tries a failed upload once more a minute later, after clearing the first try's attestation files. A required check on `main` that fails once and passes on the re-run counts as passed for the release gate.

If publication stops partway, resume from the same tag and archive bytes. The workflow verifies an existing version before skipping it. A byte mismatch stops publication; never replace a published version with different bytes.

If the visibility wait expires, check the exact version in the registry before retrying; it may already be published. Resume only after confirming its bytes match the verified archive. Do not change the version or start a separate publication to work around the delay.

The workflow's `image` job builds AgentRun Server's container from the same tag (`packages/serve/docker/Dockerfile`), linux/amd64 and linux/arm64 each on its own native runner (`ubuntu-24.04` and `ubuntu-24.04-arm`), with an SBOM and max provenance, which buildx stores with the image. It builds from the checkout, not from npm, so it starts when the run does, before the approval, and pushes each build by its digest alone. Once publication passes, `image-release` makes the two digests one image and tags it `ghcr.io/parcha-ai/agentrun-server:<tag>` and `:beta`; a release that does not publish tags nothing. GitHub's registry creates a new package private: after the first push, a maintainer makes it public once, in the package's settings.

Beside them, the `box` job, under the same `npm-release` approval, builds the box image a remote computer with an Archil mount starts from (`packages/computer/box`, for linux/amd64) and pushes `ghcr.io/parcha-ai/agentrun-box:<recipe hash>` and `:<tag>`, with an SBOM and max provenance. The recipe hash comes from `box/recipe.mjs`, and a release whose recipe is published already only adds its tag. Then, in the same job, it builds the public E2B template `agentrun-archil-<recipe hash>` from that image. It needs the secret `E2B_API_KEY` in the `npm-release` environment and stops, saying so, without it. That key is the publishing team's, whose slug is `BOX_E2B_PUBLISHER` in `packages/computer/src/box-image.ts`: E2B's provider starts the template by that team's name, so a key of another team publishes a template no E2B computer starts. E2B pulls the image with no credentials, so `ghcr.io/parcha-ai/agentrun-box` must be public too (the same one-time switch); until it is, the job stops, saying so, and a re-run of that job finishes it.

Every job waits for `gate`, which checks the tag and the tagged commit's CI run first. The jobs the `npm-release` environment holds (`publish`, `pypi` and `box`) then wait for approval at the same moment, so one review approves the release. The environment's required reviewers are the only approval; nothing in the workflow names a person.

Once `image-release` has tagged the image, the `chart` job pushes the Helm chart (`deploy/helm/agentrun`) as `oci://ghcr.io/parcha-ai/charts/agentrun` with the run's `GITHUB_TOKEN` and `packages: write` in that job alone. It is packaged from `Chart.yaml`, which the release pull request moves (`railway-template.test.mjs`). A failed push stops the GitHub release. Then `chart-public`, which holds no token, reads the chart back with no credentials, and nothing waits for it. GHCR makes a new package private, so before the first chart push an org admin makes `ghcr.io/parcha-ai/charts/agentrun` public in the package's settings. If that was missed, `chart-public` fails saying so: make it public, then re-run that job.

Once `publish`, `pypi`, `image-release`, `chart` and `box` have all passed, the `github-release` job publishes the GitHub release, "AgentRun v<version>", a prerelease for a beta, on the existing tag. Its notes are the version's `CHANGELOG.md` section exactly as the publish job's fold left it (kept as the `release-changelog` artifact), its fragment markers taken out, then the install lines: the npm version, the `@parcha/agentrun` launcher's, the Python client's, and the server image's tag with its platforms (`scripts/release-notes.mjs`). A section too long for a release body is cut at a line and links the rest: the tag's `changes/` fragments it was folded from. It never creates or moves a tag: it stops when the tag is missing or names another commit, and when the tag has a release already (`scripts/release-github.mjs`). It is the only job with `contents: write`. Write the release pull request's `CHANGELOG.md` section for its readers, with its **Upgrading and going back:**, **Breaking:** and **Known issues:** blocks: it is the release page.

Then the `website` job opens the website's import pull request. It takes an installation token of the website App (the repository variable `WEBSITE_APP_ID` and the secret `WEBSITE_APP_PRIVATE_KEY`). The App is installed on other repositories too, so the token names `Parcha-ai/agentrun-website` alone and asks for `contents: write` and `pull-requests: write` only. The job checks out this tag with its history and the website's `main`, and runs the website's own `scripts/import-content.py <tag> --release-tag <tag> --repo <this checkout>`. `scripts/release-website.mjs` then commits the change as the App's bot on `release/<tag>-content` and opens `content: import AgentRun <tag>` against `main`. With nothing changed it says the website has the release already, and a branch or an open pull request for it already there is a notice, so a re-run changes nothing. A branch left with no pull request (one a person closed, or a run that stopped after its push) is never reopened: delete the branch and re-run the job to import again. Without the App it prints one notice and stops. It continues on error, so the website never fails or blocks a release; this run's own token only reads.

The release is complete only when every published archive matches the release plan and the fresh registry installation passes. Confirm the `beta-release-<run ID>` artifact contains the release plan, archives, and `published-all.json` with `status: passed` and `cleanRegistryInstall: true`.

After publication, test the README from an empty clone and exact-version npm installation outside the workspace. Remove private or unpublished notices only when those public paths work. Website deployment belongs to the separate website repository.

The release posts nowhere on its own. Once the release page is out, whoever cut the release posts its summary to the team's Slack, as the team's bot, through the team's Slack tool. Write it for someone who uses AgentRun, not for someone who built it:

1. **What you can do now**: the release's new abilities in product words, a line each, from its section's intro and changes.
2. **Before you upgrade**: three lines, from its **Upgrading and going back:** and **Breaking:** blocks: what to do before the upgrade, whether the store moves and how to go back, and what breaks.
3. The install lines from the release page, then the link to the release notes.

See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/) and [scoped package](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) documentation for account setup.

## Check a published server

`npx @parcha/agentrun-serve` starts AgentRun Server from npm with nothing else installed: pi is built in and, with no model key or ChatGPT sign-in yet, says it needs one (capabilities: `available: false`, `needs` naming `key`), claude-agent and codex install Claude Code and Codex on first use (capabilities say `installs: "on_first_use"` until then), and the console is served. In an empty directory, with no model key in the environment, save this as `check.mjs` and run `node check.mjs`; it prints one line that starts with `ok:`. The stranger test (`scripts/stranger/agentrun-serve.json`) runs the same file against this tree's packed server.

```js
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "agentrun-check-"));
const server = spawn("npx", ["--yes", "@parcha/agentrun-serve", "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
const stop = (code) => { try { process.kill(-server.pid, "SIGTERM"); } catch {} rmSync(data, { recursive: true, force: true }); process.exit(code); };
const fail = (why) => { console.error(`not ok: ${why}`); stop(1); };
setTimeout(() => fail("the server did not start within 5 minutes"), 300_000).unref();
let out = "";
let checked = false;
server.stdout.on("data", (chunk) => {
  out += chunk;
  const started = / on (http:\/\/\S+?)\/v2 /.exec(out);
  if (!started || checked) return;
  checked = true;
  // A failed request or an unreadable answer is a failed check: it stops the server and removes its data like any other.
  check(started[1]).catch((error) => fail(`the check could not finish: ${error.message}`));
});
async function check(base) {
  const headers = { authorization: `Bearer ${readFileSync(join(data, ".token"), "utf8").trim()}` };
  const caps = await (await fetch(`${base}/v2/capabilities`, { headers })).json();
  const harness = (id) => caps.harnesses.find((offer) => offer.id === id) ?? fail(`capabilities list no ${id}`);
  // pi is built in, nothing to install: with no model key it runs nothing yet, and says what it needs.
  const pi = harness("pi");
  if (pi.installs !== undefined || pi.available || !pi.needs?.includes("key")) fail(`pi does not say it needs a model key: ${JSON.stringify(pi)}`);
  // Claude Code and Codex install themselves on first use: until then claude-agent and codex say so.
  for (const id of ["claude-agent", "codex"]) if (harness(id).installs !== "on_first_use") fail(`${id} does not say it installs on first use: ${JSON.stringify(harness(id))}`);
  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (page.status !== 200 || !/src="\.\/assets\/[^"]+\.js"/.test(html)) fail(`the console is not served (${page.status})`);
  console.log(`ok: pi needs only a model key; claude-agent and codex install on first use; the console is served`);
  stop(0);
}
server.on("exit", (code) => fail(`the server exited (${code}) before the check`));
```

## Public launch

1. Review the release source and make only the DSL repository public. Keep the website repository and any prelaunch history archive private. Verify that an unauthenticated user can clone the source and follow the README.
2. A repository admin must enable **Settings → Advanced Security → Private vulnerability reporting**. GitHub provides this feature only for public repositories. Open the [reporting form](https://github.com/Parcha-ai/agentrun/security/advisories/new) from a signed-in account without repository write access to confirm it works. A maintainer must subscribe to security-alert notifications. See [GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
3. Publish the verified packages in dependency order, then verify a clean registry installation. Until that succeeds, keep the source installation as the default and retain the unpublished-package notices. Previously prepared tarballs are invalid after source changes; rebuild and verify them.
4. Once the registry checks pass, update the package READMEs and changelog with the published version, `latest` install commands and release date. Test those exact commands outside the workspace before announcing them.
