---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's graph keeps what the run wrote whole and cuts only when it serves it, after redaction: a key saved after the graph was read is redacted from a later read too, the one a busy store answers from the kept view included. Each label, error and decision state is redacted once per held key set, not on every poll.
