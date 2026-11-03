# Console validation and remaining gates

Candidate `23bf2743349e38461601fd6e959d6801b99df46e`, including main `0ca81bce2d7cf7db398080efe2427d296a552a4d`. No merge approval, registry release or deployment.

| Proof | Result |
|---|---|
| Console typecheck and full suite | PASS at this head: 400 tests in 45 files. Current generated native contract matches. |
| Live browser / exported client | PASS at this head: 31 checkpoints / 8 real client-server results, exact asset hashes and cleanup verified. [Receipt](autoqa-report.md). |
| Clean public container | PASS 8/8 at this head: authentication/session/CSP, exact UI assets, actual faux run, summary availability, media MIME/original bytes and native image gate. [Receipt](container-proof.md). |
| Strict installed UI consumer | PASS at this head: Bundler and NodeNext with skipLibCheck disabled, public ESM/configured-base client; 65 files, 57 portable declarations and notices. Archive SHA-256 `84d0402939387f8efbb73d88fad5250cb9c9d6c56c4fd9bf5e0519e466ea84e0`. |
| Native package verification | PASS at this head: all 17 packages with installed console/license/manifest checks, offline runtime, declarations and documented native audit exceptions. |
| Clean source | PASS at this head: 3,097 files, 327 locked runtime package/version pairs; downloaded source installed, built and exercised offline demos/graphs/native discovery. Twelve dependency-license metadata flags remain for release-owner review. |
| Generated files/changelog/Storybook | PASS at this head. Native server clean-install stranger test also passed. |
| Review and queue | Zero unresolved threads; all reviews/comments fully paginated. Main contained and queue empty; approved-only #1377 conflicts before this candidate. Greptile’s prior 5/5 belongs to `3573f4a6`. [Review](review-report.md), [stack trial](stack-trial.md), [merge preservation](merge-preservation.md). |

## Broad check and CI

The full repository gate is running in a disposable Ubuntu 24.04/FFmpeg 6 environment with Node 22.23.2, npm 11.21.0 and required document/process tools. It has not yet completed; no green result is claimed.

The prior Debian13 full run at `d9ff826d` exposed three causes. The strict summary assertion omitted two new public keys; commit `9f37cc9d` reproduced and corrected the nearest HTTP regression, retaining exact-key checking and asserting actual availability values (10/10 tests passed). [Previous CI diagnosis](previous-ci-diagnosis.md) records the same sole failure in all three durable jobs. The slim image lacked `ps`; adding procps passed the unchanged full disk suite with 980 passed, zero failed and eight skipped. [Corrected tools proof](disk-corrected-tools.md).

The remaining FFmpeg7 case is a real inherited duration/index defect in the synced recorder: the identical exporter/input produces 50  frames / 5 seconds there, versus 40/4 under FFmpeg6. No recorder source/test was edited. [Reproduction and limits](frame-track-diagnosis.md). That failing run is not green; the separate console playback proofs do not invoke this exporter. The owner has been asked whether to include an upstream fix or document a separate follow-up.

Exact-head GitHub workflow [41570207587](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587) is in progress. A Node 24 examples job has failed a wall-clock-dependent carry-count assertion; baseline/source parity is under investigation. No green CI verdict is claimed. Only completed final checks establish the CI verdict.

## Dependencies and release boundary

The unchanged console lock has 14 inherited affected package entries: 7 moderate, 3 high and 4 critical. DOMPurify is the sole production entry; the other entries are build/test/development tools. The added generator introduces none. [Remediation assessment](dependency-remediation.md) records isolated lock-resolution options and compatibility limits. No upgrades were applied; owner scope decision remains pending. Native package verification uses existing audit exceptions, whose next high-severity expiry is November 6, 2026.

Native serve/decisions follow upstream’s reviewed publication policy. The new UI library remains `private:true`. Build/export/pack/verify commands perform no publication. No paid-model qualification, OS app launch, deployment or migration occurred.

File availability caps metadata reads at 128 work entries and traversal depth 16; the native walker still enumerates directory names. No hard enumeration-cost bound is claimed. Unknown availability remains unknown.
