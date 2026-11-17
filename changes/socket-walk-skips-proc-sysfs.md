---
packages: @parcha/agentrun-computer
kind: fix
---
computerd's search for the unix sockets a tool can connect to no longer goes into folders of proc or sysfs, where no socket can be a file. Cloudflare's container runtime mounts both under /run/cloudchamber, about 58,000 entries, which filled the 50,000-entry budget of the /run walk, so isolation.vendor-agent failed on Cloudflare with no socket left unsearched. The probe's sockets report has a new `skipped` list naming each folder not gone into with its filesystem, and the conformance case shows it.
