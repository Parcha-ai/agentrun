# Console validation and remaining gates

Candidate: `d9ff826df3195a2fb94530ad95d39186168341c8`, including main `bc18a59f`. Review handoff; no merge approval or publication.

| Proof | Result |
|---|---|
| Console typecheck and full suite | PASS, 400 tests in 45 files, including upstream name lookup and the pinned Playground flow. |
| Live browser | PASS, 31 checkpoints across 9 selected rows. Actual media playback, byte-exact downloads, slow polling, result/file availability, imported/archived controls and arbitrary-prefix external handoffs. |
| Exported client against actual server/run processes | PASS, 8 results including skills, revisions, idempotency, input, files, failure and restart. |
| Clean public container | PASS, 8 checks at this exact commit. Auth/session/CSP, same UI assets, actual faux run, both summary routes, media MIME/original bytes and native image gate. [Receipt](container-proof.md). |
| Strict installed UI consumer | PASS, Bundler and NodeNext with skipLibCheck disabled, public ESM/client execution, 65 files and 57 portable declarations with notices. Archive SHA-256: `e0565b0331e2ba739d60c4c66a726c9cd9f7488826fca06702b2d24d57f94ec8`. |
| Native package verification | PASS, all 17 packages, clean consumer execution/declarations, 3 demos and the repository's documented audit exceptions. |
| Clean source | PASS, 3,083 files and 327 locked runtime package/version pairs; downloaded source installed, built and exercised offline demos/graphs/native discovery. Twelve dependency-license metadata flags remain for release-owner review. |
| Generated files and changelog | PASS, generated schema/author/dependency inventory matches; fragment validator passed. |
| Packaging boundaries and Storybook | PASS, boundary/export tests and static Storybook build. |
| Review | Five automated threads answered and resolved; zero open. Current independent merge review found no blocking issue. Greptile's prior 5/5 belongs to `3573f4a6`; no fresh current-head score is claimed. [Report](review-report.md). |

The native Stop and webhook-test corrections (#1406 and #1401) have merged upstream and are included. The earlier [Stop diagnosis](ci-failure.md) and [webhook diagnosis](webhook-ci-failure.md) are historical evidence, not outstanding integration requests.

## Broad check and CI

The full repository gate is still being reconciled; it is not claimed green. All build, generated checks and typechecks passed. The first disposable test environment omitted a process reaper; the unchanged orphan-holder case passed after adding `--init`. The corrected run exposed missing `ps` in the slim image and a video-frame assertion (50 versus 40) under that image's ffmpeg. Those results are under bounded investigation with unchanged suites and a corrected tools image. No source/test weakening or skip was added.

Current-head GitHub CI is running. Read the PR checks for the live result. A final verdict requires the actual completed checks, not this static receipt.

## Dependencies and queue

The unchanged console lock has 14 inherited affected package entries: 7 moderate, 3 high and 4 critical. DOMPurify is the sole production entry; the other entries are build/test/development tools. The added generator introduces none. [Concrete remediation assessment](dependency-remediation.md) records isolated lock-resolution options and their compatibility limits. No dependency upgrade has been applied; the owner scope decision remains pending. Native package verification uses existing audit exceptions, whose next high-severity expiry is November 6, 2026.

The candidate is clean against inspected main. The [fresh queue trial](stack-trial.md) records the expected four packaging conflicts after still-queued #1405 and an earlier independent conflict in approved #1377. Already-merged #1323 and #1400 were reconciled while preserving uploads, availability metadata, complete name lookup, provider isolation and the selected Playground flow. [Merge preservation](merge-preservation.md).

The file-availability budget bounds metadata reads to 128 entries and traversal depth to 16. The native walker still enumerates each directory's names; no runtime enumeration-cost fix is claimed. Unknown availability remains unknown.

No paid-model qualification, OS application launch, hosted deployment, registry release or customer migration occurred. The UI library's publication hold remains intact. Maintainer approval and final gates remain required.
