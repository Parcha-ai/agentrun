---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
Agent37 is a computer provider (`agent37`, kind `linux` for the sandbox setting), on the shared machine-host adapter: an Agent37 instance on type `vm` (default) or `default` (gVisor), made with no network, auto-sleep off and no public port, and read back. It takes two keys, `AGENT37_API_KEY` and `AGENT37_SSH_KEY` (the private half of an SSH key registered on the same workspace, its contents), and runs every command over SSH through the platform's tunnel with the host's own `ssh2` (pinned 1.17.0 as a root devDependency). The conformance module reads `COMPUTER_AGENT37_*` behind `AGENTRUN_COMPUTER_LIVE_AGENT37=1`, and `dist/conformance/sweep.js --provider agent37` sweeps a live run. Kind `desktop` waits for the box image as an Agent37 template.
