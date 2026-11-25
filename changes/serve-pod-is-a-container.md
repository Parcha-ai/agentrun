---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
A server in a container that writes no `/.dockerenv` or `/run/.containerenv`, which its cgroup names (a Kubernetes pod, an LXC system container), now knows it runs in a container: one that reaches a Docker refuses Docker computers with that reason, instead of mounting paths the Docker host doesn't have; its Docker messages say they are the container's; and it no longer offers its pod's addresses as where another machine reaches it. The server reads its own cgroup for this the way computer's Docker provider already did, through `containerSigns`, which `@parcha/agentrun-computer` now exports.
