---
packages: repo
kind: feature
---
The supervisor writes `run.json` host lines from `place.status()` (any place that has it): the record verbatim with `gen` its generation, when its status, generation, holder or sealedSeq changes, read at a runner's start and exit, a kill and the result, and on a 2 s tick. The recorder replaces `holder.host` and `holder.bootId` with labels (`host-1`, `boot-1`, ...) and redacts this machine's own host name and boot id.
