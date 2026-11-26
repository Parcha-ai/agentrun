---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A learned workflow call in a run's `workflow_calls` whose rerun was refused now reads `refused` only while every attempt the gate let go was closed by a refusal. One with an attempt left open (a crash cut it before it kept a record, or its record says it ran) reads `failed`, even when a sibling call ran beside it, so its model nodes' spend can't be told for its own: its `usd` is null there, and null for an attempt cut after the refused record. Before, it read `refused` at $0. A CLI's own side request on another model (its title or summary helper) inside a refused call's window no longer flips the call to `failed`. A tool that nests calls, issued again after an earlier attempt fixed a value or nested a call, is now asked at the gate as `replayed`.
