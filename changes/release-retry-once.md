---
packages: repo
kind: ci
---
A release run dispatched at a beta tag, or the checks of a push to main, that fails or is cancelled on its first attempt has its failed and cancelled jobs re-run once (`.github/workflows/release-retry.yml`). Only runs whose head is in this repository are re-run: never a second attempt, a pull request (a fork's included) or the merge queue. In the release, a `pypi-watchdog` job cancels the run when the `pypi` job stays queued for 15 minutes and every npm publish job has completed with success, so that one re-run picks `pypi` up; while npm may still publish it cancels nothing. A PyPI upload that fails is tried once more a minute later with the same archives. No job waits for the watchdog.
