---
packages: @parcha/agentrun-serve
kind: fix
---
On a Mode 2 server whose Archil region has no serverless exec (`gcp-us-central1`), a new agent with `bash` and no computer is refused at its save or deploy and told to name a sandbox computer, instead of being saved with a shell that never runs (every bash call failed with "Exec is not enabled"). Capabilities' `places.default_place` is null there with a `default_reason` saying why, bash shows unavailable, and `GET /v2/computers` gives the no-computer choice no shell. Servers on Archil's AWS regions, and on a region serve doesn't know, are unchanged.
