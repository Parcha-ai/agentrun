---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
`AGENTRUN_BOX_CPUS`, `AGENTRUN_BOX_MEMORY` and `AGENTRUN_BOX_PIDS` size a Docker computer (a sandbox or a desktop) again. Since the old box stack went, the server read and checked them at its start and then gave them to nothing, so every Docker computer ran with the provider's defaults (2 CPUs, 4 GiB, 1,024 processes) whatever an operator set. The claim now puts them on the computer's spec, and the Docker provider runs the container with them. Unset, the provider's defaults hold. A vendor's computer (Daytona, Modal, E2B, Orgo, a phone, a hosted browser) sizes itself and is never given them. A value the Docker provider refuses stops the server's start, naming the setting, in the provider's words. The Docker provider's `check()` also refuses a `cpus` too large for a CPU quota (more than 90,071,992,547), which it used to pass and Docker then refused at every create.
