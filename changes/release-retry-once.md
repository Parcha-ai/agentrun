---
packages: repo
kind: ci
---
A release run dispatched at a beta tag, or the checks of a push to main, that fails on its first attempt has its failed and cancelled jobs re-run once (`.github/workflows/release-retry.yml`). Only runs whose head is in this repository are re-run: never a second attempt, a pull request (a fork's included) or the merge queue. A cancelled run is re-run only when the release's `pypi-watchdog` cancelled it; a release cancelled by hand stays cancelled. The watchdog starts once `publish` has passed and cancels the run only when the `pypi` job has been queued for 15 minutes since the approval, every npm publish job has completed with success, and every other job but those that wait for `pypi` has finished, so the cancel stops `pypi` alone; otherwise it cancels nothing. A PyPI upload that fails is tried once more a minute later with the same archives, the first try's attestation files cleared. No job waits for the watchdog.
