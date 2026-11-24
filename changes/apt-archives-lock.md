---
packages: @parcha/agentrun
kind: fix
---
`install.sh --vps` waits again for apt's other locks on a server that has just booted. That covers the archives lock that apt-daily's download holds on first boot, which made the Docker install fail at once. It still stops on dpkg's lock after apt-get's own 600 s wait. apt-get runs under `LC_ALL=C`, so the lock messages are matched on a server set to any language. `deploy/fly/launch.sh` also stops before a deploy when `fly volumes list --json` has entries without a `name` or `region`, as it already does for the secrets list. Before, such a list read as no volume, and a run naming another region deployed onto a new, empty volume.
