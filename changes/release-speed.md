---
packages: repo
kind: ci
---
A release takes about 20 minutes and one approval instead of about 85 minutes and three. The release workflow publishes every npm layer back to back and then waits for the registry once, as long as its slowest package, instead of once per layer. AgentRun Server's image builds each architecture on its own native runner from the start of the run and is tagged only after the packages are published and verified. A new `gate` job checks the tag and its CI run first, then `publish`, `pypi` and `box`, which now also builds the E2B template, wait for the `npm-release` approval together, so one review approves them all.
- Until every package is visible, which takes up to about 10 minutes, an install of a package whose dependency npm does not show yet can fail. Before, a layer was verified before the next one was published.
- PyPI and the box image and E2B template can now be published for a tag whose npm publish then fails.
