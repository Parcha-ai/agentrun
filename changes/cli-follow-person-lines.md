---
packages: @parcha/agentrun
kind: feature
---
`agentrun runs timeline RUN_ID --follow` on a terminal prints one line per timeline row instead of JSON: its time (UTC), the subagent that wrote it, its kind, and what it says (a tool call's tool and input, a result's tool, `ok` or `failed`, and output, a usage row's dollars, "at most" when that is an upper bound). A row prints again only when its line changes, so a resumed connection repeats nothing, and the run's status prints when it changes, with its cost on the final page (again "at most" for an upper bound). The run's text loses control characters and bidirectional overrides before it reaches the terminal, and a line is cut at 200 characters. Piped, `--follow` prints one page per line (NDJSON) as before.
