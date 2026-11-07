# Release a beta

The packages are `@parcha/agentrun-dsl`, `@parcha/agentrun-jev`, `@parcha/agentrun-pi`, `@parcha/pi-durable-disk`, `@parcha/pi-browser`, `@parcha/pi-vision`, `@parcha/pi-transport`, `@parcha/pi-durable-agent`, `@parcha/pi-git-remote`, `@parcha/pi-agent-learn`, `@parcha/agentrun-decisions`, `@parcha/agentrun-kernel`, `@parcha/agentrun-harness-claude`, `@parcha/agentrun-harness-codex` and `@parcha/agentrun-serve`. They share a version and are published in that order (`pi-durable-disk`, `pi-browser`, `pi-vision`, `pi-transport`, `pi-durable-agent` and `pi-git-remote` depend on none of the others; `pi-agent-learn` depends on `dsl`, `pi` and `pi-git-remote`; `agentrun-decisions` and `agentrun-kernel` depend on `dsl`, `agentrun-harness-claude` and `agentrun-harness-codex` on `dsl` and `agentrun-kernel`, and `agentrun-serve` on `dsl`, `jev`, `pi`, `pi-browser`, `pi-durable-disk`, `pi-durable-agent`, `agentrun-decisions`, the kernel and both harnesses). `@parcha/agentrun-harness` is in the repository but held; see [Held packages](#held-packages). `@parcha/agentrun`, the `npx @parcha/agentrun` command, is published after the server it depends on, at a version of its own; see [The command's own version line](#the-commands-own-version-line). Publication is manual; pushes, pull requests and tags do not publish packages.

## The command's own version line

`@parcha/agentrun`, the `npx @parcha/agentrun` command (`packages/agentrun`), is published by every release but not at the workspace version: it has a version line of its own, from 0.3.0, above the 0.2.x that the hosted API's TypeScript SDK published under the same name from its own repository. `ownVersionPackages` in `scripts/changes.mjs` names it; the release preflight checks it at its manifest's version, a plain `x.y.z`, and it is published in the layer after `@parcha/agentrun-serve`'s.

- **The release sets its version, and every release moves it.** Its manifest pins the server at the release version, so the release pull request moves both: the pin to the new workspace version and the command to its next `x.y.z`. A pull request that changes what it publishes (its manifest, `bin/`, `lib/`, README, LICENSE or NOTICE) leaves the version alone and adds a fragment for `@parcha/agentrun`; the release's changelog names the version that ships. `node scripts/changes.mjs --check`, which CI runs on every pull request, refuses a pull request that moves the version, and a release commit that changes those files and keeps it. A version bump of it alone is not a release commit.
- **A release resumes or stops on it, after the server.** The release probes it in its layer: a version already on npm with the same bytes is verified and skipped, as for any package; one with other bytes stops the release there, after the other packages are published, and the fix is a version bump. `changes --check` refuses that on the release pull request first.
- **It runs the server it was released with.** `@parcha/agentrun-serve` is its one dependency, at the release's exact version (`release-preflight` refuses any other), so `npx @parcha/agentrun@<version>` always installs the same server, and its version line says which. Until the server of a release is on npm, that release's command cannot be installed, so it is published after it.
- **`latest` must stay on it.** `npx @parcha/agentrun` runs what the `latest` tag names. A publish of the SDK from its own repository must use another tag (for example `npm publish --tag sdk`), or `latest` moves back to 0.2.x and the command loses its bin.

## Held packages

The packages a release may publish are named, in publication order, in `releasePackageNames` in `scripts/release-preflight.mjs`: dependencies first (`dsl`, then `jev` and `pi`), then the packages that depend on none of them, `pi-agent-learn`, which uses `dsl`, `pi` and `pi-git-remote`, `decisions` (`@parcha/agentrun-decisions`), which uses `dsl`, the harness kernel (`@parcha/agentrun-kernel`), which uses `dsl`, and the harnesses on it (`@parcha/agentrun-harness-claude` and `@parcha/agentrun-harness-codex`), which use `dsl` and the kernel, `serve` (`@parcha/agentrun-serve`), which uses `dsl`, `pi`, `pi-durable-disk`, `pi-durable-agent`, the kernel and the harnesses, the command (`@parcha/agentrun`), which uses `serve`, and the reference host (`@parcha/agentrun-harness`), which uses `dsl`, `pi`, `pi-browser`, `pi-durable-disk` and `pi-vision`, last. That list is the gate for a new package: `release-preflight` fails when a workspace package is neither private nor named there, so a package is never published by accident. A package whose manifest says `"private": true` is held. It is built, tested, typechecked and checked by `verify-packages` and `verify:tarball`, and it is bumped with the workspace version in every release PR like the rest (`release-preflight` fails if its version differs from the workspace's), but it is skipped at publication: the publish set (`releasePackages`, which `verify-published` and the workflow's publish loop read) is the named packages that are not held. `@parcha/agentrun-harness` is held while publishing it is on hold. Lifting a hold is one commit that removes `"private": true` from the package's manifest, after its npm bootstrap and trusted publisher exist (see "Prepare publication").

## Verify the source and packages

Use Node 22.23.2, npm 11.21.0 and GNU tar for release verification. From a clean checkout:

```sh
npm install --global npm@11.21.0 --ignore-scripts
npm ci --ignore-scripts
npm run check
npm run export:source
node scripts/check-generated.mjs
npm run verify:packages -- --console
npm run verify:source
```

`npm run check` builds first, and the root build builds the console before the workspaces (`scripts/build-console.mjs`), so the server's build copies it into the archive `@parcha/agentrun-serve` publishes, with `THIRD-PARTY-NOTICES.txt`: the console's Vite build writes that file from the bundle's own module list (each bundled package, its version, its license and its license text), and the server's `NOTICE` points to it. `--console` stops verification when the server's archive lacks either. The release workflow runs the same steps.

Inspect `.release/verification.json` and `.release/source-consumer.json`. Package verification installs the exact tarballs into an empty consumer. Source verification checks the archive against its export receipt, then extracts, installs, builds and exercises its offline examples. Dependency installation requires network access.

Regenerate schemas, packaged demo data and the dependency inventory when their sources change. Verify that LICENSE, NOTICE and applicable asset notices accompany the source and package archives. Offline checks establish execution behavior; live adapter compatibility needs a separate configured check.

## Prepare publication

Confirm publishing access to the `@parcha` npm organization. New packages need an initial authenticated publication before a trusted publisher can be associated with them. Arrange that bootstrap with the package owner; the release workflow does not create accounts, grant ownership or complete this first-publication setup. `@parcha/agentrun-serve` and `@parcha/agentrun-decisions` are new in the publish set: each needs that bootstrap and its trusted publisher before the first release that publishes it, or that release stops at it. The existing `@parcha/agentrun` package is separate.

Once each package exists, configure its trusted publisher for this repository's `release.yml` workflow. This workflow publishes directly, so the association must allow direct publishing. Configure the `npm-release` GitHub environment with maintainer review and allowed tags. Subsequent workflow releases use OIDC and provenance. See [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) for publisher configuration.

Before creating the release tag:

1. Confirm who will start the workflow. A GitHub App needs **Actions: write** to dispatch or rerun it; repository contents access alone is insufficient. If the App lacks this permission, arrange a maintainer dispatch before starting the release.
2. Confirm who can approve `npm-release`. If **Prevent self-review** is enabled, the person starting the workflow must have a different eligible reviewer. A sole reviewer who also dispatches needs self-review allowed; keep the required review and allowed-tag restrictions.
3. Include any release-script or workflow fixes in the reviewed commit before tagging. A rerun uses the tagged source, not newer fixes on `main`. Release tags cannot be moved or deleted, so a tag on the wrong commit costs that version number: run the preflight at a local tag in a clean checkout before pushing the tag.

Complete the [public launch checklist](#public-launch) before announcing the release. Review source, repository refs and retained GitHub records before changing visibility. Source export checks do not review issues, pull requests or Actions artifacts.

Before the tag, fold the changelogs with one command: `node scripts/changes.mjs --fold 0.1.0-beta.1 --date 2026-10-20` (the date defaults to today, UTC). In the root `CHANGELOG.md`, and in each package changelog that has fragments, it renames the `Unreleased` section `## 0.1.0-beta.1 (2026-10-20)`, keeping its bullets and adding the fragments' bullets after them, and opens a new empty `Unreleased` section above it. A fragment goes to its package's own changelog, else the root; a package changelog with no fragment is untouched. It deletes the fragments. Commit the result with the version bump. The preflight refuses a tag while a fragment remains or the root `CHANGELOG.md` has no section for the version.

The fold and the version bump are one commit, the release pull request, and CI guards it. A release commit is one where any workspace `package.json` version differs from the merge base's (the pull request's base, or the merge queue's base for a queued one). On it, `changes/` must hold only `README.md`; otherwise the required `verify` jobs fail with `release commit carries unfolded fragments: <names>; refold on current main`. That happens when another pull request adds a fragment after the fold was made. Refold on current main (`node scripts/changes.mjs --fold <version>`) and push; the queue then takes the release pull request again. A release that folded, merged main and folds a late fragment in a second commit gets the same changelogs as one fold of all of them, for held and for published packages: the fold takes the first fold's output (a held package's run in its Unreleased section, a published package's dated section, which one fold groups by kind and orders by fragment name) back to the merge base's text (`--base`, default `origin/main`) and rebuilds it with the late fragments in the fold's order. A section that was edited by hand since the first fold is not rebuilt; the late bullets go after it. `--check` refuses a hand edit of a held package's Unreleased section, but it reads only Unreleased sections, so it does not see an edit of a published package's dated section. Every other commit is untouched, a fold that changes no version included.

So the tag always goes on the release pull request's own merge commit, and there are no separate fold pull requests: a fold changes no version, so the guard would not fire on one, and a late fragment would reach the tag unfolded.

Create a reviewed beta tag whose version matches every package, such as `v0.1.0-beta.1`. At that exact tag:

```sh
node scripts/release-preflight.mjs --tag v0.1.0-beta.1
```

The preflight checks tag identity, clean source, package versions, licenses and verified archive bytes. A passing check does not authorize publication.

## Publish and verify

Dispatch **Publish verified beta** with the workflow ref and `tag` input set to the same reviewed tag, after `ci.yml` has finished on the tagged commit's push to `main`. The workflow does not run the suites again: it first requires that run's `verify (<node>)` jobs to have passed (`scripts/release-ci-gate.mjs`), with `verify (22.19.0)` and `verify (22.23.2)` present, and stops if the run is missing, still running or red. Other jobs of that run do not stop a release. It then builds and runs the checks that make the archives, requires a public repository, publishes the verified archives with the `latest` tag in dependency layers (each layer published, then all of its packages verified against the registry at once, a failure stopping the release before the next layer), and verifies registry integrity and a fresh installed consumer. A version is published as `latest` because npm's package page shows the README of the publish that carried the `latest` tag; moving `latest` later with `npm dist-tag` leaves the page without one. The install commands in the READMEs and docs name `@latest`, so a release needs no step after the run for them to install it.

The `beta` dist-tag is kept only for older links that name `@beta`, and the workflow does not move it: it publishes as a trusted publisher, which can publish but cannot run `npm dist-tag`. To bring it up to a release, a maintainer with npm rights runs `npm dist-tag add <name>@<version> beta` once for each published package, with that release's version. It is optional; nothing in this repository installs `@beta`.

An npm publish success can mean the package is still processing. The verifier waits up to 20 minutes in each of three phases: for a version's registry document to appear, for its tarball to download, and for npm to list every release version in both the full and the abbreviated (install) metadata. It polls every 5 seconds at first and backs off to every 30. npm took about 5 minutes to show beta.10 and 16 for beta.11's first package; the job's own limit is 45 minutes, so several slow packages in a row can still end the run, and a rerun on the same tag resumes. Only then does it run its one clean installation. It still fails immediately on authentication errors or mismatched integrity. Do not treat npm's acceptance message as a completed release.

If publication stops partway, resume from the same tag and archive bytes. The workflow verifies an existing version before skipping it. A byte mismatch stops publication; never replace a published version with different bytes.

If the visibility wait expires, check the exact version in the registry before retrying; it may already be published. Resume only after confirming its bytes match the verified archive. Do not change the version or start a separate publication to work around the delay.

Once publication passes, the workflow's `image` job builds AgentRun Server's container from the same tag (`packages/serve/docker/Dockerfile`, for linux/amd64 and linux/arm64) and pushes `ghcr.io/parcha-ai/agentrun-server:<tag>` and `:beta`, with an SBOM and max provenance, which buildx stores with the image. GitHub's registry creates a new package private: after the first push, a maintainer makes it public once, in the package's settings.

The release is complete only when every published archive matches the release plan and the fresh registry installation passes. Confirm the `beta-release-<run ID>` artifact contains the release plan, archives, and `published-all.json` with `status: passed` and `cleanRegistryInstall: true`.

After publication, test the README from an empty clone and exact-version npm installation outside the workspace. Remove private or unpublished notices only when those public paths work. Website deployment belongs to the separate website repository.

See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/) and [scoped package](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) documentation for account setup.

## Check a published server

`npx @parcha/agentrun-serve` starts AgentRun Server from npm with nothing else installed: pi runs, claude-agent and codex install Claude Code and Codex on first use (capabilities say `installs: "on_first_use"` until then), and the console is served. In an empty directory, with no model key in the environment, save this as `check.mjs` and run `node check.mjs`; it prints one line that starts with `ok:`. The stranger test (`scripts/stranger/agentrun-serve.json`) runs the same file against this tree's packed server.

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
  if (!harness("pi").available) fail("pi is not available");
  // Claude Code and Codex install themselves on first use: until then claude-agent and codex say so.
  for (const id of ["claude-agent", "codex"]) if (harness(id).installs !== "on_first_use") fail(`${id} does not say it installs on first use: ${JSON.stringify(harness(id))}`);
  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (page.status !== 200 || !/src="\.\/assets\/[^"]+\.js"/.test(html)) fail(`the console is not served (${page.status})`);
  console.log(`ok: pi runs; claude-agent and codex install on first use; the console is served`);
  stop(0);
}
server.on("exit", (code) => fail(`the server exited (${code}) before the check`));
```

## Public launch

1. Review the release source and make only the DSL repository public. Keep the website repository and any prelaunch history archive private. Verify that an unauthenticated user can clone the source and follow the README.
2. A repository admin must enable **Settings → Advanced Security → Private vulnerability reporting**. GitHub provides this feature only for public repositories. Open the [reporting form](https://github.com/Parcha-ai/agentrun/security/advisories/new) from a signed-in account without repository write access to confirm it works. A maintainer must subscribe to security-alert notifications. See [GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
3. Publish the verified packages in dependency order, then verify a clean registry installation. Until that succeeds, keep the source installation as the default and retain the unpublished-package notices. Previously prepared tarballs are invalid after source changes; rebuild and verify them.
4. Once the registry checks pass, update the package READMEs and changelog with the published version, `latest` install commands and release date. Test those exact commands outside the workspace before announcing them.
