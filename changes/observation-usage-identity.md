---
packages: @parcha/agentrun-serve
kind: fix
---
Keep verified session identity privately beside retained observation usage, independently of current
learning readiness. Disconnecting, replacing credentials, or receiving an older client's activity
no longer counts observed tokens separately from the same session's captured runs. Existing verified
associations migrate when another observation arrives; the accounting identity grants no learning
authorization and is removed with the retained session.

If an earlier disconnect already discarded the verified identity, it cannot be reconstructed. Where
unidentified observations may overlap recorded native runs, usage compares the complete native view
with each collector's complete observation view and reports a conservative total with incomplete
coverage. It does not add possibly overlapping collectors or infer an identity from unverified fields.

A verified report that tries to assign a different native identity to an already identified observed
session is refused with `409 connector_session_identity_conflict`. The entire batch remains uncommitted,
including its usage and receipts; distinct native sessions must use distinct external session IDs.
