---
packages: @parcha/agentrun-dsl
kind: docs
---
Source-comment corrections in the DSL, no behaviour change: the `effectFiles` JSDoc now names `writeHandoffFiles` (the stale `writeFrozenEvidence` no longer exists), the `executeCode: false` note sits on `validateWorkflow` where it belongs (not on `RETRY_ON_NAMES`), an orphaned `sameValue` comment is dropped, and `applyHostOutputTypes` states why it does not descend into child workflows. The compiled output differs only in these comments.
