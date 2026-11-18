---
packages: repo
kind: docs
---
A release no longer posts to Slack on its own: the release workflow's `slack` job and `scripts/release-slack.mjs` are gone. Whoever cuts a release posts its summary once the release page is out, in the shape `docs/releasing.md` gives: what you can do now, three lines on what to do before you upgrade, then the install lines and the link to the release notes.
