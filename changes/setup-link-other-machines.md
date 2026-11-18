---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
A server listening on every address (`--listen 0.0.0.0` or `::`) with no public URL now prints its setup link at this machine's own IPv4 addresses too, `From another machine: http://192.168.1.169:7401/setup#code=…`, after the `Set up this server: http://127.0.0.1:…` line, each time a new code is printed. Before, the only link named 127.0.0.1, which does not open from another machine. Loopback, link-local and container-bridge addresses are left out, at most three are printed, and none are printed inside a container, whose addresses are not the ones its host publishes. The launcher passes these lines on as it does the setup line.
