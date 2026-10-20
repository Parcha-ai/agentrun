---
packages: @parcha/agentrun-dsl
kind: feature
---
A rejected workflow says where and which rule: `validateWorkflow` returns `issues` beside `errors`, one `{ path, code, message }` per error in the same order, with `message` the same text, and `WorkflowInvalidError` carries the same `issues`. `errors` is unchanged. `path` is a JSON Pointer into the workflow as written naming what the rule is about (a node, at the same path `inspectWorkflow` gives it; a schema; or `""` for the document's own fields and a supplied input), never a missing key. `code` is one of 16 rules, the exported `ValidationCode`; the guide lists each with an example. The set may grow, so keep a default branch.

A dry run says whether every check ran: `dryRunWorkflow` results gain `status`, `passed`, `not_run` (`ok` stays true and `skipped` gives the reasons, as before) or `failed`. `ok` and the CLI's exit codes are unchanged; `agentrun dry-run --strict` exits 3 when the status is `not_run`.
