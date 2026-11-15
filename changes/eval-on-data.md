---
packages: @parcha/agentrun-serve
kind: feature
---
`agentrun-serve eval-template --on-data DIR` runs the eval's own server on DIR, a stopped server's data folder, in place of a temp one. The runs use what that server keeps, so a package's cases are measured on the owner's ChatGPT plan, and every case's fakes still bind (`now`, `email`, `web`, `monid`), which `--server` refuses. The agents the eval made are archived there and the folder stays, with its tool settings and MCP servers as they were; the report says `server: {kind: "in_process", data: DIR}`. It is refused with `--server`, while another server holds DIR, when DIR's server has enabled triggers or runs not ended (the eval's server and runner would take them up), and for an email case when DIR's server keeps an email account, which the case's fake mailbox would replace. `EvalOptions.data` is the same in the API.
