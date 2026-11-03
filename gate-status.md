# Console validation and review gates

Candidate `cf668bea326996da873c755bab7dbc3e356932aa`, including main `c8307c987088b174a42623635753bb2e27a9ac6b`. The final main merge changes only server tests and a changelog fragment. Complete diff inspection proves all production source, console build inputs, manifests and locks match fully tested `23bf2743`. [Preservation and affected tests](upstream-integration-proof.md).

| Proof | Result |
|---|---|
| Full repository check | PASS `npm run check` at `23bf2743`: all builds/generated checks/typechecks/workspace suites, 435 release tests, 604 examples and viewer suite. [Stages and limits](full-check-proof.md). |
| Current changed native tests | PASS at `cf668bea`: 781 tests, 780 passed, zero failed, one existing Docker-buildx check skipped, in isolated no-key Ubuntu. Host legacy viewer also passed 403 with five external-recording skips, closing the image’s Chrome-dependent skips. [Receipt](upstream-integration-proof.md). |
| Console typecheck and full suite | PASS 400 tests in 45 files at `23bf2743`; console source and build inputs unchanged at this candidate. Generated native contract matches. |
| Browser and exported client | PASS 31 browser checkpoints and eight real client/server results at `23bf2743`, with exact final JS/CSS hashes and cleanup. [Receipt](autoqa-report.md). |
| Clean public container | PASS 8/8 at `23bf2743`: auth/session/CSP, exact UI bytes, actual faux run, both availability summaries, MIME/raw media bytes and native image gate. No new image digest is claimed for the test-only merge. [Receipt](container-proof.md). |
| Installed packages | PASS strict UI Bundler/NodeNext consumers, 65 files/57 portable declarations; all 17 native consumers with installed console/license/manifest checks. Tested `23bf2743`, production bytes unchanged. UI archive SHA-256 `84d0402939387f8efbb73d88fad5250cb9c9d6c56c4fd9bf5e0519e466ea84e0`. [Receipts](package-proof/package-proof.md). |
| Fresh public source | PASS at `cf668bea`: 3,098 files, 327 runtime package/version pairs; downloaded archive installed, built and exercised offline demos/graphs/native discovery. Twelve license metadata review flags remain. [Current source proof](current-source-proof/source-proof.md). |
| Generated/changelog/Storybook/newcomer | PASS. Final source inventory and fragment check current at `cf668bea`; unchanged Storybook and installed server newcomer flow passed at `23bf2743`. |
| Review and queue | Five threads resolved, zero requests outstanding; all reviews/comments paginated. Main included, queue empty. Approved-only #1377 conflicts before candidate. Prior automated 5/5 belongs to `3573f4a6`. [Review](review-report.md), [trial](stack-trial.md). |

## CI

Current [workflow 41572842831](https://github.com/Parcha-ai/agentrun/actions/runs/41572842831) completed **SUCCESS** on `cf668bea`, updated November 3, 2026 at 03:48:32 UTC. The Node 24 examples carry case passes without a repair. **All 74 jobs/checks passed**, zero failed/pending. The review receipt records full pagination and final base/queue readback.

The historical `23bf2743` workflow finished 70 passed/four failed: one timing-sensitive examples carry-count assertion and three dependent verify gates. The unchanged targeted case passed twice on pristine main; no reproduced baseline failure or environment waiver was claimed. It passes in the current CI run without a repair. [Historical diagnosis](ci-diagnosis.md). A deterministic replacement plan exists as optional maintenance; no test was changed to obtain this green case.

The earlier strict run-summary key assertion was corrected with meaningful availability-value checks and now passes locally and in CI. [Previous diagnosis](previous-ci-diagnosis.md). Tool-image missing-process-utility failures were resolved without source changes. [Corrected environment](disk-corrected-tools.md).

## Recorded follow-ups and publication

The unchanged console lock has 14 inherited affected package entries: seven moderate, three high and four critical. DOMPurify is the sole production entry; the rest are build/test/development tools. The added generator introduces none. [Remediation options](dependency-remediation.md) remain a separate owner scope decision. Native package audit exceptions remain explicit in the package receipts; next high expiry is November 6, 2026.

The synced recorder has a real inherited FFmpeg7 duration/index defect: identical exporter/input yields 50 frames/five seconds there versus 40/four under FFmpeg6. [Reproduction](frame-track-diagnosis.md). Its failing run remains a failure; it is distinct from existing-file playback and the passing Ubuntu/FFmpeg6 full check. No synced recorder fix was applied.

Implementation is complete for review. Maintainer approval remains required for merge. The new UI library remains `private:true`. Native serve/decisions follow upstream’s reviewed release policy. No registry publication, deployment, paid-model qualification, OS app launch, customer migration or merge approval occurred. Twelve license flags and `publicationReady:false` remain release-owner review items.

File availability caps metadata reads at 128 work entries and depth 16; directory-name enumeration retains the native walker’s cost. No hard CPU/memory enumeration bound is claimed. Unknown availability remains unknown.
