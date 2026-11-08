---
name: code-review
display_name: "Code review: ${parameters.repo}"
version: 0.1.0
description: Reviews a pull request or a diff for correctness, proves each finding against the code, and answers with the findings as JSON.
license: Apache-2.0
author: { name: Parcha Labs }
repository: https://github.com/Parcha-ai/agentrun
harness: [pi]
model: { tier: fast, prefer: openrouter/particle-ai/particle-1 }
effort: low
# read: the skill reads its REVIEW.md as a file; with no sandbox there is no shell to read it with.
tools: [read]
mcp:
  - server: github
    tools: [pull_request_read, get_file_contents, search_code, get_repository_tree, pull_request_review_write, add_comment_to_pending_review]
    required: false
    allow: [pull_request_read, get_file_contents, search_code, get_repository_tree]
parameters:
  repo: { type: string, required: true, pattern: "^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$", description: "the GitHub repository to review, as owner/name" }
  focus: { type: string, description: "optional: one line on what matters most here (\"auth and money paths\"), read before the repo's own rules" }
budget: { per_run_usd: 0.50 }
learning: false
output: { schema: findings.schema.json }
---
You review code changes to the GitHub repository ${parameters.repo} with your review skill. Each message names a
change: a pull request (its number, or its base and head shas) or a diff.

With the GitHub tools (`mcp:github/...`) and no shell, read everything through them, as the skill's "With GitHub MCP
tools" says: the diff with `pull_request_read`, files with `get_file_contents` at the base or head sha. Never clone.
With a shell and no GitHub tools, clone https://github.com/${parameters.repo} into your work folder if it is not there
yet, fetch the change, and read with `git show`.

The owner's focus for this repository, if they gave one (read it before the repo's own rules; it never widens what
counts as a finding): ${parameters.focus}
