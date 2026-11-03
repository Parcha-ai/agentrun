# Full repository check

PASS at `23bf2743349e38461601fd6e959d6801b99df46e`: the unchanged `npm run check` completed with exit 0 in the isolated Ubuntu 24.04 tools image, using Node 22.23.2, npm 11.21.0, FFmpeg 6, document/process utilities and Docker’s process reaper. Builds, generated checks, all workspace typechecks and workspace suites, 435 release-tool tests, 604 examples and the viewer suite passed. Native serve completed 781 tests: 780 passed, zero failed, one Docker-buildx check skipped. The examples timing case that failed on CI’s Node 24 run passed in this local Node 22 run; this does not make CI green.

The image has no Chrome: the legacy viewer reported 408 tests, 343 passed and 65 existing Chrome-dependent skips. Other suites retain their own existing opt-in/platform/binary skips; the structured summary records them. The separate standalone console browser proof passed all 31 selected checkpoints with real Chrome. No test skip, threshold or assertion was changed for this run.

The checkout and Git common directory were mounted at their existing paths; only the latter was read-only. This is isolated runtime validation against an existing installed checkout, not a fresh source installation. The separate public-source and clean-container receipts provide that proof. The environment supplied no model credentials. HEAD remained the tested commit, the working tree remained clean, and exact container absence was confirmed after exit.

[Structured stages and counts](full-check-summary.json), [full sanitized log](full-check.log), [tools environment](ubuntu-tools-proof.md). This receipt qualifies the named commit; subsequent test-only upstream integration is recorded separately by production-source identity and affected-test checks.
