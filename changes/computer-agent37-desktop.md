---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
Agent37 serves the desktop setting: `create({ kind: "desktop" })` makes a Linux desktop (`screen`, `input.pointer`, `input.keys` beside the shell) whose Xvfb the adapter starts through the daemon as the tool user. Its default image is `agentrun-box` (`AGENT37_BOX_TEMPLATE`), our box image plus Xvfb as a template of the key's own workspace: `AGENT37_API_KEY=... node packages/computer/box/build-agent37.mjs` builds it once per workspace, and again only when the recipe changes. The conformance module takes `COMPUTER_AGENT37_KIND=desktop`.
