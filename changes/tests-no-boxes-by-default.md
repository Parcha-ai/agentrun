---
packages: repo
kind: ci
---
Tests that start a server with an environment of their own (the server-record test, the npx command's `cli` and `follow` tests) set `AGENTRUN_BOXES=none` instead of dropping it, and so do the decision demos' runner and the smokes' faux server unless the caller names boxes. Since the Docker box is on by default, these made real Docker calls on CI runners, built the box image and raced their own cleanup.
