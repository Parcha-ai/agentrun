---
packages: repo
kind: ci
---
A release run, or the checks of a push to main, that fails or is cancelled on its first attempt has its failed and cancelled jobs re-run once (`.github/workflows/release-retry.yml`). A second attempt is never re-run, and pull requests and the merge queue are not re-run. In the release, a `pypi-watchdog` job cancels the run when the `pypi` job stays queued for 15 minutes, so that one re-run picks it up, and a PyPI upload that fails is tried once more a minute later with the same archives. No job waits for the watchdog.
