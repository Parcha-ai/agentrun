---
packages: @parcha/agentrun-serve
kind: breaking
---
A trigger has no `overlap` field any more, in its view, `GET /v2/capabilities` and the OpenAPI document: a firing while its last run is active is always skipped, with why, which the docs state as its behaviour. `triggers.json` is read in this build's shape alone: a trigger missing `catchup_window_s`, `failures_in_a_row` or `disabled`, or firings kept under `run_now_kept`, are no longer read as defaults or copied over (shapes only unreleased builds wrote). Upgrading: a trigger's view and the capabilities no longer carry `overlap`; a firing while the last run is active is always skipped. Nothing to re-save.
