---
packages: @parcha/agentrun
kind: fix
---
`install.sh --vps` waits for another apt-get to finish before it installs Docker, as on a server that has just booted with cloud-init or unattended-upgrades still running apt. Each apt-get waits up to 600 s for dpkg's lock, and one that could not get the package lists' lock is tried again for up to 600 s. Before, the install stopped at the first lock it could not get.
