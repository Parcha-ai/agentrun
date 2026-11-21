---
packages: @parcha/agentrun-serve
kind: fix
---
Install Codex learning hooks in linked worktrees through the main-checkout `hooks.json` that native
Codex actually loads. Reconnecting migrates unchanged owned hooks without changing the learning
connection or credential. Shared-file locking and stable hook group positions preserve other enrolled
projects and their native trust keys; worktree-local TOML stays untouched. Observation readiness checks
the derived shared configuration and does not mark ignored local hooks ready. Modified configuration,
invalid Git ownership and size overflow fail without replacement; interrupted migrations retain both
ownership records for safe disconnect. Loaded Codex project configuration requires a new or reopened
session before hooks activate. A nested linked worktree cannot also learn through its enclosing checkout.
