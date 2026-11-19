---
packages: @parcha/agentrun-serve
kind: fix
---
`PUT /settings/mcp-servers/{name}/composio` takes an action slug of at most 128 characters: a longer one is `422 input_invalid` with reason `invalid` under `tools` (and `maxLength: 128` in the schema), before Composio is asked anything, in place of a `not_found` that named it by its first 64 characters and its length. A slug the toolkit doesn't list is still `422` `not_found`, now with a guess only when it is a listed slug in another case ("linear_list_issues (did you mean LINEAR_LIST_ISSUES?)"); a slug a letter or a `_WORD` off is named without one.
