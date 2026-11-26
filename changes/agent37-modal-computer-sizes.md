---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
Agent37 and Modal computers report their size, so their time can be priced: an Agent37 machine carries the vCPUs, memory and disk Agent37's instance answer gives (`resources`, memory and disk in GB), and a Modal computer carries the limits its create set (2 vCPUs and 4096 MB unless the spec asks other sizes), since Modal reads no size back and bills a sandbox by its use up to those limits. A run on either, with `AGENTRUN_COMPUTE_USD_PER_*` prices set for the provider, now books its `compute_time` lines under the run's cap instead of reading them `unpriced`; Agent37's disk is priced too where a disk price is set.
