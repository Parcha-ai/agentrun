---
packages: @parcha/agentrun-serve
kind: feature
---
`POST /v2/runs/{run_id}/messages` takes an optional `said`: the person's own words, when `content` is a host's text around them (a preamble, the earlier report, turn instructions). The model still gets `content` alone; the run's learning keeps `said` as the owner's correction (one line of `corrections.md`) and as the follow-up in its compile turn's traces, so a host's scaffolding never lands under `# Learned`. A message with no `said` is kept as before. A `said` that is empty, not a string or longer than `limits.max_message_chars` is 422 `input_invalid` at `said`, nothing written. The generated clients carry the field.
