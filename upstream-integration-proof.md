# Final test-only upstream integration

Current commit `cf668bea326996da873c755bab7dbc3e356932aa` includes main `c8307c987088b174a42623635753bb2e27a9ac6b`. The complete diff from fully tested `23bf2743` consists only of nine native server test/helper files and one changelog fragment. All production source, console build inputs, manifests, dependency locks and declaration sources are identical. [Complete changed-path identity](production-preservation.json).

The new helper waits for a server’s actual ready line or process exit. It coexists with the console’s existing test helpers. After the merge, the unchanged full native suite passed in the same no-key Ubuntu tools environment: **781 tests, 780 passed, zero failed, one existing Docker-buildx check skipped**, exit 0. The exact test container was removed and absence read back. No product change was needed.

The host’s legacy viewer suite also passed: **408 tests, 403 passed, zero failed, five existing external-recording skips**, using Node 22.23.1 and Google Chrome 156.0.8078.79. This covers the Chrome-dependent cases skipped by the tools image; the remaining five require DOCUMENT_RECORDING, CITED_RECORDING, FILM_RECORDING, VISION_RECORDING or AUDIT_FIXTURE inputs. No skip was added.

One native run was mistakenly launched on the host first: 772 passed and nine failed, with Ghostscript missing in four PDF tests and ambient model/harness availability violating no-key fixture expectations in five cases. That run is not green. The proper isolated run passed every same test without source/test changes. No host package was installed or key reconfigured.

The [full repository check](full-check-proof.md), [31-checkpoint console browser/client proof](autoqa-report.md), [public container](container-proof.md) and [installed package proofs](package-proof/package-proof.md) retain their actual tested `23bf2743` identities. Their production inputs match this commit; no new exact-image digest or fresh full-suite invocation at `cf668bea` is claimed. The final source export and any downloaded-source proof record their own current archive identity.

[Isolated native log](upstream-helper-native.log), [host viewer log](host-viewer.log), [production/source identity](production-preservation.json). CI and review state are in [gate status](gate-status.md).
