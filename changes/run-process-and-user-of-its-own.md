---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Each run is a process of its own under its runner, and in the image a user of its own; `GET /v2/capabilities` says which as `run_isolation` (`"uid"` or `"process"`).
  - The run's process is handed its own keys on a pipe and a channel to its runner. Over the channel it reads and writes its journal, under the runner's fence, and the store's rows of its own run and agent, each call checked against its claim. What the seal key opens for the run, the runner opens and hands over; the seal key, the API token and the store's URL stay in the runner. A run's own model key (`model_key`) is opened by its runner, at its claim and for each message that hands one; a run that holds one is handed none of the server's model keys. A frame past 32 MiB, or one that is no message of the channel, fails the run.
  - In the image, slot `s` of a runner runs as uid and gid `1001 + s`, through `agentrun-runas` (root:node `0750`, file capabilities `cap_setuid`, `cap_setgid`, `cap_setpcap`): its slot's group alone, no capability, `no_new_privs`. The data directory is `0711` and the store's files `0600`. At a run's end every process of its uid is killed and its files in `/tmp`, `/var/tmp` and `/dev/shm` are removed.
  - A platform that strips file capabilities or sets `no-new-privileges` makes the runner refuse to claim, in words naming the setting; `AGENTRUN_RUN_USER=same` runs every run as the runner's own user instead, said on its log. Runners in containers of their own on one `/data` volume take slots from an `AGENTRUN_RUN_SLOT_FIRST` of their own (`deploy/compose.yaml`: 0 and 128).
  - A local install has no helper: each run is a process of its own as the user who started the server (`run_isolation: "process"`).
