---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
POST /runs/{run_id}/messages counts `said` in Unicode code points for its 4,000 limit, as its schema's `maxLength` and a host's own count (Python `len()`) do. An emoji is one character, not two: a `said` of 4,000 emoji is taken, where it was refused as `too_long`.
