---
packages: @parcha/agentrun-serve
kind: feature
---
Add Agent Factory, a kanban view of sessions reported to the server: waiting, working, needing attention, or with unknown source activity. Cards link to the existing run viewer and to GitHub work established by launch or trigger provenance. Reported active child conversations stay visible, SDK sessions are labeled observed, and ended failures and escalations needing attention appear separately. The same sessions also read as a list grouped by state, one row each, where a state's heading folds its rows away: a List and Cards switch beside the totals picks the view, and the browser keeps the pick.

Active and review scopes on the runs API filter before keyset pagination, including archived active executions and an audit's shadow run while it runs, while excluding imported history. The console refreshes bounded pages, exposes remaining coverage, and keeps last-known cards visibly stale when a refresh fails. This visibility layer does not schedule work, grant new controls, or infer verification or merge state.
