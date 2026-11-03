# PR #1408 read-only stack trial

Observed `2026-11-03T02:40:43.295205+00:00`. Candidate `d9ff826df3195a2fb94530ad95d39186168341c8`; main `bc18a59f7d7275726ec42cd70d4adca96140493d`. This is a textual merge trial, not runtime qualification or approval.

- Current main merges cleanly with the candidate: exit 0, tree `004f2fa1ade72b71a49ef897a9b2f65914cea699`. Main is an ancestor; 0 unintegrated main commits.
- Fully paginated snapshot: 34 open PRs, 8 approved, 7 queued. Every approved/queued head and complete file list was read; final metadata confirmed approvals, queue order and all selected heads unchanged.
- Remote main remained `bc18a59f7d7275726ec42cd70d4adca96140493d` at the final check. Tracked status and checkout head were unchanged by this audit.
- The normal main merge now includes #1400 names, #1323 uploads, #1403 workspace roots, #1404 keyless search and #1402 relaunched timelines. Prior App/README conflicts are resolved. No unmerged PR code was incorporated by this audit.

## Every approved/queued head

| Queue/status | PR and title | Head | Files/shared | Candidate after earlier PR |
|---|---|---|---|---|
| 1 AWAITING_CHECKS | [#1399](https://github.com/Parcha-ai/agentrun/pull/1399) docs(serve): the console's build is the root build's, and a webhook may reach your own machine or network | `c3da329e96fd6c0ffab5f2265a382f573a7654d8` | 4 / 3 | CLEAN |
| 2 AWAITING_CHECKS | [#1413](https://github.com/Parcha-ai/agentrun/pull/1413) ci: npm retries registry requests, and npm ci runs once more on a network error only | `ad9af6ca1d9ace8e7d440e4ba8a7f4ac9414f200` | 6 / 2 | CLEAN |
| 3 MERGEABLE | [#1411](https://github.com/Parcha-ai/agentrun/pull/1411) ci: the pi compatibility check runs as five parallel jobs per pi version | `2d7dec5963235568c98461b70ea730c30fe8f595` | 4 / 1 | CLEAN |
| 4 MERGEABLE | [#1409](https://github.com/Parcha-ai/agentrun/pull/1409) fix(serve): host-owned names are matched by identity | `765667c2011122d73be64c1e84998d0cca5096b6` | 7 / 3 | CLEAN |
| 5 AWAITING_CHECKS | [#1405](https://github.com/Parcha-ai/agentrun/pull/1405) build(serve): the server is published, its console and notices with it | `06868a04f1469a63f037135485ddb5e7f2673099` | 18 / 7 | CONFLICT: apps/console/vite.config.ts, packages/serve/NOTICE, scripts/build-console.mjs, scripts/verify-packages.mjs |
| 6 AWAITING_CHECKS | [#1415](https://github.com/Parcha-ai/agentrun/pull/1415) test: dsl's fractional poll wait on fake timers; scripted pids past any real pid | `41768714f4cd10dac6795f6237b41419c71dfbc7` | 3 / 0 | CLEAN |
| 7 AWAITING_CHECKS | [#1412](https://github.com/Parcha-ai/agentrun/pull/1412) ci: the merge queue runs the test shards on one Node version; pull requests and main run all three | `85484a2ea235bd38d3b9709b4c7f92f89a77079f` | 2 / 1 | CLEAN |
| Approved, not queued | [#1377](https://github.com/Parcha-ai/agentrun/pull/1377) feat(serve): a saved monid key works on every harness, only in the runs that name it, with its charges in the run's cost and cap | `51c4908701a0fb163aea0d1dfae0494bf3cb191b` | 32 / 4 | Earlier PR conflicts with main |

Each independent trial merges the earlier head onto pinned main with `git merge-tree --write-tree`, creates an unreferenced two-parent commit with `git commit-tree`, then appends the candidate. No checkout, branch, index, source, push, or PR mutation occurs.

## Shared paths

- **#1399:** `packages/serve/README.md`, `packages/serve/src/page.ts`, `packages/serve/test/files.test.mjs`.
- **#1413:** `.github/workflows/ci.yml`, `scripts/build-console.mjs`.
- **#1411:** `.github/workflows/ci.yml`.
- **#1409:** `packages/serve/README.md`, `packages/serve/src/openapi.ts`, `packages/serve/src/server.ts`.
- **#1405:** `.github/workflows/ci.yml`, `apps/console/vite.config.ts`, `packages/serve/NOTICE`, `packages/serve/README.md`, `packages/serve/scripts/copy-page.mjs`, `scripts/build-console.mjs`, `scripts/verify-packages.mjs`.
- **#1412:** `.github/workflows/ci.yml`.
- **#1377:** `packages/serve/README.md`, `packages/serve/src/openapi.ts`, `packages/serve/src/runs.ts`, `packages/serve/src/server.ts`.

## Combined trials

- Queue order: #1399 → #1413 → #1411 → #1409 → #1405 → #1415 → #1412.
- All 7 queued heads merge cleanly in that order. Appending this candidate conflicts only in `apps/console/vite.config.ts`, `packages/serve/NOTICE`, `scripts/build-console.mjs`, `scripts/verify-packages.mjs`.
- Approved-only #1377 conflicts before this candidate is applied: `packages/pi-durable-agent/src/timeline/index.ts`, `packages/pi-durable-agent/src/timeline/timeline.ts`, `packages/serve/README.md`, `packages/serve/src/host-tools.ts`, `packages/serve/src/runs.ts`, `packages/serve/src/server.ts`, `packages/serve/src/tool-keys.ts`, `packages/serve/test/fixtures/faux-model.mjs`, `packages/serve/test/host-tools.test.mjs`, `packages/serve/test/import.test.mjs`, `packages/serve/test/tool-keys.test.mjs`. No all-approved clean stack is claimed.
- #1321 is now REVIEW_REQUIRED at `1e97fb7c22a49141d30114b22c88f790e885ca74` and is not queued. Its earlier approved-head conflict is historical, outside the current approved/queued set.

## Remaining future merge gate: #1405

[#1405 — build(serve): the server is published, its console and notices with it](https://github.com/Parcha-ai/agentrun/pull/1405) is still open at the pinned head. Its intent is native server publication through the release workflow with the bundled console, canonical emitted third-party notices, and installed-package verification.

Preserve its explicit native release policy while leaving the separate UI library held. Combine its canonical license emission with this candidate’s dependency/private-import checks, exact asset manifest, font/license contents and static/library input hashes. Keep one notices output and update the installed consumer checks to validate both. After an actual merge, rebuild the app/library, verify generated assets and source/export boundaries, test installed consumers and run package/release preflight checks. This trial does not authorize incorporating #1405 before it lands.

Actual conflicting hunks from the independent earlier-PR trial:

### apps/console/vite.config.ts

```
<<<<<<< 59c6c15d4beeeb1276fcd8247d5e0980cff5dd9a
import { thirdPartyNotices } from "./third-party-notices.mjs";
=======
import { consoleBoundary } from "./build-boundary.mjs";
>>>>>>> d9ff826df3195a2fb94530ad95d39186168341c8
```

```
<<<<<<< 59c6c15d4beeeb1276fcd8247d5e0980cff5dd9a
  // THIRD-PARTY-NOTICES.txt beside index.html: the licenses of what the bundle holds (third-party-notices.mjs).
  plugins: [react(), thirdPartyNotices()],
=======
  plugins: [react(), consoleBoundary()],
>>>>>>> d9ff826df3195a2fb94530ad95d39186168341c8
```

### packages/serve/NOTICE

```
<<<<<<< 59c6c15d4beeeb1276fcd8247d5e0980cff5dd9a
The console in dist/console bundles third-party software. dist/console/THIRD-PARTY-NOTICES.txt names each
package it holds, with its version, its license and its license text.
=======
The console includes third-party code and fonts. Their license texts are in
dist/console/THIRD-PARTY-NOTICES.txt, distributed beside its static assets.
>>>>>>> d9ff826df3195a2fb94530ad95d39186168341c8
```

### scripts/build-console.mjs

```
<<<<<<< 59c6c15d4beeeb1276fcd8247d5e0980cff5dd9a
const INPUTS = ['apps/console/src', 'apps/console/index.html', 'apps/console/package.json', 'apps/console/package-lock.json', 'apps/console/tsconfig.json', 'apps/console/vite.config.ts', 'apps/console/third-party-notices.mjs', 'apps/console/tailwind.config.ts', 'apps/console/postcss.config.js', 'packages/dsl/src'];
=======
const INPUTS = ['apps/console/src', 'apps/console/index.html', 'apps/console/package.json', 'apps/console/package-lock.json', 'apps/console/tsconfig.json', 'apps/console/vite.config.ts', 'apps/console/vite.library.config.ts', 'apps/console/tsconfig.library.json', 'apps/console/build-library.mjs', 'apps/console/build-boundary.mjs', 'apps/console/tailwind.config.ts', 'apps/console/postcss.config.js', 'packages/dsl/src'];
>>>>>>> d9ff826df3195a2fb94530ad95d39186168341c8
```

### scripts/verify-packages.mjs

```
<<<<<<< 59c6c15d4beeeb1276fcd8247d5e0980cff5dd9a
    // The console bundles third-party code; its notices ship beside it, one section per bundled package with its license
    // text, and NOTICE points to them. React and the fonts are in every console bundle, so a notices file without them is not
    // this bundle's.
    const notices = await readFile(join(consumer, 'node_modules/@parcha/agentrun-serve/dist/console/THIRD-PARTY-NOTICES.txt'), 'utf8').catch(() => '');
    assert.match(notices, /^Third-party software in the AgentRun console\n/, 'the installed agentrun-serve has the console\'s notices, dist/console/THIRD-PARTY-NOTICES.txt');
    for (const name of ['react', 'react-dom']) assert.match(notices, new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ \\(MIT\\)\\n\\n\\S`, 'm'), `the console's notices list ${name} with its license text`);
    // Its fonts reach the bundle as assets a stylesheet imports, not as modules: their license is listed too.
    for (const font of ['jetbrains-mono', 'schibsted-grotesk']) assert.match(notices, new RegExp(`^@fontsource/${font} \\d+\\.\\d+\\.\\d+ \\(OFL-1\\.1\\)\\n\\n\\S`, 'm'), `the console's notices list its font @fontsource/${font} with its license text`);
    const serveNotice = await readFile(join(consumer, 'node_modules/@parcha/agentrun-serve/NOTICE'), 'utf8');
    assert.match(serveNotice, /dist\/console\/THIRD-PARTY-NOTICES\.txt/, "agentrun-serve's NOTICE points to the console's notices");
    receipt.checks.push('The installed agentrun-serve carries the console (dist/console/index.html) and its third-party notices (dist/console/THIRD-PARTY-NOTICES.txt, which NOTICE names); its files passed the same scans.');
=======
    assert.match(await readFile(join(consoleDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8'), /Third-party software.*AgentRun console/);
    const assets = JSON.parse(await readFile(join(consoleDir, 'asset-manifest.json'), 'utf8'));
    assert.ok(Array.isArray(assets.files) && assets.files.length > 0, 'the installed console has an exact asset manifest');
    for (const file of assets.files) {
      assert.ok(/^(?:assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*|THIRD-PARTY-NOTICES\.txt)$/.test(file), 'manifest files are public assets');
      assert.ok((await readFile(join(consoleDir, file))).length > 0, `manifest asset is installed: ${file}`);
    }
    receipt.checks.push('The installed agentrun-serve carries the console (dist/console/index.html); its files passed the same scans.');
>>>>>>> d9ff826df3195a2fb94530ad95d39186168341c8
```

## Merge preservation review at current head

- App keeps provider-owned typed capabilities, session identity/generation remounting and client cache/auth invalidation. It does not restore a duplicate capabilities request or the old capability cast.
- Active and archived agent name lists are paginated. Explicit `agents.list:false` skips and clears the lookup; `archive.agents:false` skips the unsupported archived listing. Newest-read and cleanup guards discard stale results. Partial failures preserve successful names and keep missing names unknown until the lookup is complete.
- The upstream create/run regression follows administration → exact pinned API playground → native request → run detail, preserving the chosen administration design. Archived-agent and partial-archived-read tests remain.
- Native upload preparation, workspace cwd, keyless-search wiring and timeline recovery changes coexist with the unchanged additive result/file-availability summaries. OpenAPI and generated console types contain uploads and both optional nullable availability fields. README retains upload `file_ids` and accurate bounded-metadata-scan documentation.
- No substantive merge preservation regression was found in this bounded source review. Local focused proof: 41 App/provider/playground tests and typecheck passed during resolution. Root subsequently reported all 400 console tests and typecheck passing at this head. Earlier 01970/12fc browser/native/container receipts are historical until the new build is proven.
