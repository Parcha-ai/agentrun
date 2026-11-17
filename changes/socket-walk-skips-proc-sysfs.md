---
packages: @parcha/agentrun-computer
kind: fix
---
computerd's search for the unix sockets a tool can connect to no longer goes into mounts of proc, sysfs or the kernel's other views (cgroup, debugfs, tracefs, securityfs, bpf, configfs, pstore, binfmt_misc, fusectl, autofs), where no socket can be a file. It finds them in /proc/self/mountinfo, and still walks any other mount below one, so a tmpfs mounted under proc is searched. Cloudflare's container runtime mounts proc and sysfs under /run/cloudchamber, about 58,000 entries, which filled the 50,000-entry budget of the /run walk, so isolation.vendor-agent failed on Cloudflare with no socket left unsearched. The probe's sockets report has a new `skipped` list naming each mount not gone into with its filesystem, and the conformance case shows it.
