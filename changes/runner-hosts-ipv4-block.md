---
packages: @parcha/agentrun-serve
kind: feature
---
Runners that are replicas of one deployment (Kubernetes pods, a platform service's instances) now relay dial computers and serve live views across hosts: `AGENTRUN_RUNNER_LIVE_HOST` and the server's `AGENTRUN_RUNNER_HOSTS` take an IPv4 block such as `10.0.0.0/14`. A runner given a block answers at its own one address in it, and the server dials any IPv4 address in a block it lists, never one outside. Such runners had no host name the server resolves, so their relay stayed on loopback and a dial computer they made could not attach. A block names its network address and a prefix from /8 to /32.
- A runner whose block holds none, or several, of its machine's addresses is refused at its start in words, and `runner --check` fails `AGENTRUN_RUNNER_LIVE_HOST` the same way; where the setting names a host, the check now says where the server reaches the runner.
