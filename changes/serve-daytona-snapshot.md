---
packages: @parcha/agentrun-serve
kind: feature
---
`AGENTRUN_DAYTONA_SNAPSHOT` names the Daytona snapshot every Daytona computer is made from, as `AGENTRUN_DOCKER_IMAGE` names Docker's image. A Daytona computer in Mode 2 mounts the run's folder as root through the box image's root helper, so it needs a snapshot of the computer package's `box/Dockerfile` (`box/build-daytona.py` builds one and prints its name); until now serve always asked for Daytona's default snapshot, which the mount refuses. Unset, nothing changes. The Daytona box (`AGENTRUN_BOXES=daytona`) never reads it.
