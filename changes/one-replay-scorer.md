---
packages: @parcha/agentrun-serve
kind: fix
---
Learning: a replay, a threshold refit and a serving revision's graded check score their rows with one function (`scoreRows` over refit rows), so the numbers a refit promotes on are the ones a replay would give its new revision. A refit record's `agree` now counts the revision as it serves, its new guard fit included. No API shape changed.
