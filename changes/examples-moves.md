---
packages: repo
kind: docs
---
`examples/moves`: one run moves from this machine to a Modal VM and back through the disk; on the VM, one session forks 8 threads, each with its tools on its own H100 sandbox. It runs offline with a scripted model and stand-in sandboxes (`npm run demo:moves -- --handoff`), and its recording validates as agentrun.recording/1.
