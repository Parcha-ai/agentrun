---
name: ship-pr
description: "The one gate every pull request to Parcha-ai/agentrun passes before it goes to the maintainer: fresh base, local checks, the changes fragment check, the stranger test, each package's live checks run on a maintainer's machine, CI, zero unresolved threads, and a stack trial against every approved and queued pull request. Then a batch line for the maintainer, who approves; the queue merges. Use for /ship-pr PR[ PR...], 'gate #N', 'is #N ready', or before adding any PR to an approval batch."
---

# Ship a pull request

One gate, the same for every package and every author. It ends in a batch line the maintainer
approves; nothing here approves. Main stays green because every merge goes through the merge queue,
pinned to the head that was gated.

`AGENTS.md`, `CONTRIBUTING.md` and `changes/README.md` on `origin/main` are the authority. Where this
file disagrees with them, they win: fix this file in the same session.

Machine-specific facts (where credentials live, each credential wrapper, the approval command, a shared
slot for paid runs, a model gateway) live outside the repository: in the file `SHIP_PR_LOCAL` names, else
`local.md` beside this file, which is gitignored. Read it first when it exists; it never enters a commit.

## Repo facts (re-check when a step disagrees)

| Fact | Value |
|---|---|
| Protection | ruleset `main`: pull request, 1 approval, stale approvals dismissed on push, threads resolved, linear history; merge queue, ALLGREEN, up to 5 entries, squash |
| Required checks | `verify (22.19.0)` and `verify (22.23.2)`; `gh api repos/{owner}/{repo}/rulesets` is the authority. Every other job (stranger, floors, `pi-1-2`, `real-chrome`, `transport-docker`, `lean`) is a merge condition by this skill, not by the ruleset: a red one is fixed or named with its cause in the batch line |
| Toolchain | Node 22.19 or later; npm 11. Regenerate `package-lock.json` only with npm 11 (`--package-lock-only`), never by hand |
| Changelog | a fragment in `changes/` per pull request with a user-visible change; no pull request edits an `Unreleased` section (`changes/README.md`) |
| Identity | the machine identity authors, pushes, replies, resolves and arms auto-merge; only the maintainer approves |

## Step 1: facts, pinned to one head

```bash
R=Parcha-ai/agentrun
gh pr view <n> -R $R --json number,title,isDraft,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,files,body
git fetch -q origin && git rev-list --count <head>..origin/main
```

Record the head SHA from `headRefOid`. Every later step is about that SHA; never type one by hand.
A draft is its author's: gate it only when it is marked ready.

## Step 2: fresh base

If the pull request conflicts with `origin/main`, or main changed a file it touches, rebase it
(an approved pull request is never pushed: its approval would be dismissed and it goes back to the
maintainer). Regenerate generated files with their generators (`npm run export:source`, the lock with
npm 11), never by hand. Push with `--force-with-lease=<branch>:<old-head>`.

## Step 3: local checks on the head

```bash
npm ci --ignore-scripts && npm run build
npm run check
node scripts/changes.mjs --check --base origin/main
npm run export:source && node scripts/check-generated.mjs
npm run verify:source
npm run verify:packages          # when a package's files, manifest or the lock change
```

Then `node scripts/stranger.mjs <name>` for every package whose README, `bin`, exports or demo the
pull request touches (specs in `scripts/stranger/`).

A test that fails on `origin/main` too is not the pull request's: show the same failure on main and
name it in the batch line.

## Step 4: live checks, per package

Run on a maintainer's machine whose environment already holds the credentials. Never in GitHub
Actions, never with a secret added to the repository. A package's section says when its check is
required, the command, the pass rule and the cost. Its lead owns that section.

### `@parcha/agentrun-dsl`, `@parcha/agentrun-jev`, `@parcha/agentrun-pi`

- **When:** any change to `packages/dsl`, `packages/jev` or `packages/pi`.
- **pi versions:** each version in its own disposable checkout, because `--scratch` rewrites the manifests
  and the lockfile: `git worktree add ../leg-<version> <head>`, then in it `npm ci --ignore-scripts` and
  `node scripts/pi-leg.mjs --pi <version> --scratch --npm "npx --yes npm@11.21.0"`, at the lowest version the
  peers accept (CI's floor jobs run 1.0.4) and at the newest minor they accept (the `pi-1-2` job runs 1.2.0).
  `--plan` only prints the leg. Pass: build, type-check and suite green, one copy of each pi package at the
  leg's version. Remove the checkout by its exact path afterwards.
- **Recovery or durable behaviour** (the driver, the journal, reconcile, effects, `./durable`): the PR
  body carries a kill-storm proof on the head: seeds, kills, every outside call applied once, every
  record equal to the uncut run's, no stop. Cost: $0 (scripted providers).
- **Recording format:** a change to what `./durable` exports for `agentrun.recording/1` validates
  with `apps/viewer`'s `validate` on a fresh recording.

### `@parcha/pi-durable-disk`

- **When:** the diff touches `packages/pi-durable-disk/src/**`, `bin/**`, `package.json` or
  `test/live/**`. A diff of only examples, the README or `changes/` skips it.
- **Pending:** `test/live/ci.ts` lands with pull request #472; until it is on `main`, this check is not run and the
  batch line says so.
- **Command,** from the repository root at the head, under your scratch-disk credential wrapper, which
  exports `ARCHIL_API_KEY`, `PDA_LIVE_DISK` and `PDA_LIVE_REGION` (default `aws-us-east-1`):

  ```bash
  npm run build && node packages/pi-durable-disk/test/live/ci.ts all
  ```

  `all` runs a preflight (it refuses without the key, a `dsk-` disk id or a region), the host suites
  (claim, env, run, store, supervise, lifecycle), then the Docker suites, so the two never share the
  disk, then a sweep that always runs and must leave 0 run directories and 0 token users, then a summary.
- **Pass:** exit code 0 and a last stdout line that starts with `ok: live disk check passed`. Anything
  else blocks: a non-zero exit, a last line `not ok: <step>: <reason>`, or no last line (killed or timed
  out). Put the summary it prints above that line in the pull request body.
- **Needs:** Docker, FUSE and the Archil client on the machine (the suites need root through
  `archil-scoped`), and a SCRATCH key and disk only. The suites delete runs and token users on the disk
  they are given: never run them with a production key.

### `@parcha/pi-browser`

- **When:**
  - **Real Chrome:** any change to `packages/pi-browser/src/**`, `package.json`, `scripts/**`, `test/**` or `examples/**`, or to `package-lock.json` when it moves a pi-browser dependency.
  - **Package contents:** a change to the manifest (`exports`, `files`, `bin`, `peerDependencies`) or to anything the tarball ships.
  - **Provider live check:** a change to `src/providers/**` (Browserbase, Kernel, the shared HTTP and CDP code), `src/recorder/**`, or the session lifecycle in `src/core/lease.ts` and `src/store.ts`.
  - A diff of only the README or `changes/` runs the stranger spec and nothing else here.
- **Real Chrome,** from the repository root at the head, with `CHROME_PATH` naming Chrome for Testing at the version CI pins (`CHROME_FOR_TESTING` in the workflow):

  ```bash
  npm ci --ignore-scripts && npm run build
  npm run test:chrome -w @parcha/pi-browser
  node scripts/check-reference-chrome.mjs
  npm test -w @parcha/pi-browser
  ```

  **Pass:** each command exits 0. The suites fail a file that leaves a process or a directory behind, so a teardown leak is a failure, not a warning.

  A fix for a flaky test also runs that file 16 times, four at a time, on Node 22.19 and on the newest Node CI uses, plus a forced version of the race it fixes. The body gives the counts. A flake fixed only by hoping is not fixed.
- **Package contents:** `npm run verify:tarball -w @parcha/pi-browser`. **Pass:** exit 0. Then `node scripts/stranger.mjs pi-browser`, whose spec runs the README's no-key command and must print the README's block byte for byte.
- **Provider live check,** once per provider the change can reach, with that provider's key already in the environment (`BROWSERBASE_API_KEY` for Browserbase, plus the Browserbase SDK installed; `KERNEL_API_KEY` for Kernel):

  ```bash
  PI_BROWSER_PROVIDER=browserbase node packages/pi-browser/examples/one-script-three-providers.mjs https://example.com
  PI_BROWSER_PROVIDER=kernel node packages/pi-browser/examples/one-script-three-providers.mjs https://example.com
  ```

  **Pass:** exit 0, and one stdout line that starts with the provider's name and quotes the page's first snapshot line. The script releases its session in a `finally`. Confirm in the provider's console, or with its session list, that no session it made is still running. A change to the recorder also records that session and shows frames within the caps, a `credential_on_page` gap on a password page, and `session_released` last, with no token in any line.

  Paste the provider lines and the session check into the body. Never paste a session's connect or live-view URL: they carry tokens.
- **Needs:**
  - Chrome for Testing at CI's pinned version. On Ubuntu 24.04, an unprivileged Chrome needs `kernel.apparmor_restrict_unprivileged_userns=0`, the runner's documented switch; the sandbox stays on.
  - Node 22.19 or later.
  - For the live check, a Browserbase or Kernel key whose plan allows at least one concurrent session.
  - No other credential, and no secret ever goes into the repository.
- **Cost:** the Chrome suites and the stranger spec are $0. A provider live check is one session of about a minute. At Browserbase's list price ($0.12 per session-hour, one-minute minimum) that is under $0.01; Kernel is on the same order.

### `@parcha/pi-transport`

Three live checks: Docker (free, on every source change), Daytona and Modal (paid, when the code they reach
changes). Each suite labels every box it makes with a label of its own run, lists that label at the provider at the
end, and fails if a box is left. All three run from the repository root at the head after `npm run build`.

- **When:**
  - **Docker:** the diff touches `packages/pi-transport/src/**`, `package.json`, or a `test/*docker.live.test.ts`
    file. A diff of only the README, `changes/` or offline tests skips it.
  - **Daytona:** the diff touches `src/box/daytona.ts`, the shared box code (`src/box/box.ts`, `files.ts`,
    `child.ts`), `src/hands/**`, or `test/box-*daytona*.live.test.ts`.
  - **Modal:** the diff touches `src/box/modal.ts`, the shared box code, `src/hands/**`, or
    `test/*modal*.live.test.ts`.
  - A change under `src/home/**` runs the Docker check (the home suites are Docker files) and, when the change moves
    a session between providers, Daytona and Modal too.
- **Command:**

  ```bash
  npm run build
  npm run test:live:docker -w @parcha/pi-transport
  # Daytona, under the credential wrapper that exports DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_TARGET:
  PI_TRANSPORT_LIVE_DAYTONA=1 npm run test:live -w @parcha/pi-transport
  # Modal, under the wrapper that exports MODAL_TOKEN_ID and MODAL_TOKEN_SECRET:
  npm install --no-save --ignore-scripts modal@0.11.0
  PI_TRANSPORT_LIVE_MODAL=1 npm run test:live -w @parcha/pi-transport
  ```

  `test:live` loads every live file; each provider's own variable picks the files that run, and the others skip.
  `PI_TRANSPORT_LIVE_MODAL_KINDS` picks Modal kinds (`sandbox,vm` by default; add `gpu` only when the change
  touches GPU handling). `PI_TRANSPORT_LIVE_PREFIX` and `PI_TRANSPORT_LIVE_LABELS` (`a=b,c=d`) name and label the
  run's boxes, so two runs never touch each other's boxes.
- **Pass:** each command exits 0 and its Vitest summary shows `0 failed` (skipped files are fine). A non-zero exit,
  a failed test, or a run killed before its summary blocks. The suites' own last test counts the run's boxes still
  at the provider; a non-zero count fails the run. Put each summary line in the pull request body.
- **Needs:** a Docker daemon and Node 22.19 or later; for Daytona, a key for a TEST organization (never a
  production key) and its API URL and target; for Modal, a token pair and the `modal` SDK installed with `--no-save`
  (the package never depends on it). No credential enters a box, a log or the pull request.
- **Cost:** Docker $0. Daytona under $0.05 a run (about 60 short one-vCPU boxes, seconds each). Modal sandbox and VM
  under $0.10 a run; the T4 kind adds about $0.05 when asked for. Estimates from list prices.

### `@parcha/pi-vision`

Two live checks. Both run from the repository root at the head, after `npm ci --ignore-scripts && npm run build`.

**1. Programs on this machine** (ffmpeg, ffprobe, poppler, LibreOffice: the versions a host really has, not CI's).

- **When:** the diff touches `packages/pi-vision/src/core/{read,readers,video,pdf,office,derive,image}.ts`,
  `packages/pi-vision/src/providers/**`, `packages/pi-vision/src/node.ts`, `packages/pi-vision/test/binaries/**` or
  `packages/pi-vision/package.json`.
- **Command:**

  ```bash
  npm run test:binaries -w @parcha/pi-vision
  ```

- **Pass:** exit code 0 and `# fail 0` in its summary. A skip is allowed only for a program the machine does not
  have, and the body names it (for example "LibreOffice absent: 1 skipped"). A missing ffmpeg, ffprobe or poppler is a
  fail, not a skip.
- **Needs:** ffmpeg and ffprobe, poppler-utils, optionally LibreOffice (`soffice`) on PATH. No key. Cost: $0.

**2. Real eyes** (one paid look through pi-ai, the path no fake covers).

- **When:** the diff touches `packages/pi-vision/src/eyes/**`, `src/core/guard.ts`, `src/core/evidence.ts`,
  `src/core/limits.ts`, `src/core/look.ts`, `src/durable.ts`, or the `@earendil-works/*` peer or dev ranges in
  `packages/pi-vision/package.json`.
- **Command:**

  ```bash
  node packages/pi-vision/test/live/eyes.mjs
  ```

  It reads `PI_VISION_LIVE_EYES` (`<provider>/<model id>`, the public id pi-ai's catalog uses) and that provider's
  key from the variable pi-ai itself reads; `PI_VISION_LIVE_BASE_URL` points it at a gateway when the machine has one
  (a machine fact: it goes in `local.md`). It refuses to run without them. It makes three checks: a synthetic scanned
  letter (built by `./testing`) whose identifier the eyes must read exactly; a two-page PDF through `read` with `page`;
  and the receipts, where the paid look has `cost_usd` as a number and tokens above 0, and a forced no-eyes miss has
  `cost_usd: 0`.
- **Pass:** exit code 0 and a last stdout line that starts with `ok: pi-vision live eyes passed`. Anything else
  blocks: a non-zero exit, a last line `not ok: <step>: <reason>`, or no last line. Put the summary it prints (model,
  read rate, tokens, dollars) in the pull request body.
- **Needs:** one key for an eyes route that takes images. Use a model that reads identifiers reliably; the package's
  eyes bench measured some routes dropping digits, and this check would then fail as designed.
- **Cost:** about $0.01 a run.

## Step 5: CI and threads

- Every check run on the head is green. A red non-required job is either fixed, or shown to fail the
  same way on `origin/main` or on an unrelated head, with its run id and cause in the batch line.
  The machine identity cannot re-run a job; push a new head (only before approval) or name it.
- Zero unresolved review threads, counted by GraphQL over every page (`--paginate` follows `endCursor`):

```bash
out=$(gh api graphql --paginate -f query='query($endCursor:String){repository(owner:"Parcha-ai",name:"agentrun"){pullRequest(number:<n>){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)|1') && printf '%s' "$out" | awk 'END{print NR}'
```

A failed query prints nothing and exits non-zero; that is not a count of zero: fix the credential and ask again.

Every thread is fixed or declined with reasons, answered, and resolved. The review bot reviews when a
pull request opens or is marked ready; ask it again (`@greptile-apps please review again`) only after
a push that fixed a P0 or P1, or when it has not reviewed after 15 minutes, at most twice per pull
request.

## Step 6: stack trial

Before a pull request joins a batch, list the changed files of every pull request that is approved
or in the merge queue, from every author, and of every other pull request in the batch:

```bash
gh pr list -R $R --state open --json number,reviewDecision --jq '.[]|select(.reviewDecision=="APPROVED")|.number'
gh api graphql -f query='{repository(owner:"Parcha-ai",name:"agentrun"){mergeQueue(branch:"main"){entries(first:20){nodes{pullRequest{number}}}}}}'
comm -12 <(gh pr view <n> -R $R --json files --jq '.files[].path' | sort) <(gh pr view <m> -R $R --json files --jq '.files[].path' | sort)
```

For each one that shares a file, merge them as a stack in queue order and show it is clean:

```bash
t=$(git merge-tree --write-tree origin/main <first-head>) && c=$(git commit-tree "$t" -p origin/main -p <first-head> -m trial)
git merge-tree --write-tree "$c" <next-head>
```

A conflict means the later pull request waits for the earlier one to merge, then rebases. Never
claim "no overlap" from one pull request's file list alone.

## Step 7: the batch line

A gated pull request goes to the maintainer as one line in the batch file named in `local.md`:
`<number> <full head SHA from gh> <one line: what it does>`, with comment lines above it naming

- its hard blocks, if any: public API, stored format, peer ranges or dependency pins, durability
  semantics, release process, CI (`.github/`), anything a published package's user must change;
- the proof (step 4) and the CI and thread state;
- the stack trial result.

The maintainer approves at that SHA; the machine identity then arms auto-merge with
`gh pr merge <n> --auto --squash --match-head-commit <sha>`, so a later push never lands. A head that
moved after the gate is skipped and gated again.

## Step 8: after it merges

Watch the queue by GraphQL (`isInMergeQueue`, `mergeQueueEntry{state position}`); `autoMergeRequest`
reads null while a pull request is queued, so never re-arm on that. A pull request dropped from the
queue goes back to step 2. After the merge, check the `push` run on main for the merge commit; a red
required job caused by the merge gets a revert pull request at once, gated like any other.
Tell every lead whose pull request touches the same files.

## Hard rules

1. Nothing here approves: the maintainer does, at the gated SHA.
2. No secret, credential, machine name, internal host or path in any file, test, fixture, commit or
   pull request text of this public repository.
3. Live checks run on a maintainer's machine, never in GitHub Actions.
4. A gate result is true as of the moment it was computed: re-gate before acting on a stale one.
