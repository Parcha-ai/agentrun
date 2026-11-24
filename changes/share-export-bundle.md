---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: feature
---
An ended run can be exported as a share bundle: `GET /v2/runs/{run_id}/export` (and `agentrun runs export RUN`) answers one `agentrun.share/1` JSON document with the run's allowlisted view fields, its Timeline rows, a workflow's graph, its UTF-8 text files within the caps, what was left out and why, and a sha256. Every string in it is cut by the scrubber with the values this server holds as its held values. Each cut is a record with its place, rule, kind and shape, never its value. A known key format, a held value and a dump are cut for good; a value beside a label and a personal detail can be put back with `?restore=<cut ids>`. Two exports of the same run are the same bytes. A run still at work answers 409, a withheld run 403, a bundle over 8 MiB 413, and a scrub that fails answers 500 with an empty body.
A tool's output in the bundle (a result's preview, an approval outcome's text, a workflow call's output) is cut knowing the file the call read or the command it ran, so a read of `~/.pgpass` or the output of `env` is one dump cut, and `agentrun-serve scrub` counts it the same way.
