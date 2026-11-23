---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
`agentrun deploy` checks the package as the target's import checks it before it sends anything, and refuses one the target would refuse: exit 2, the target's own words, no request made and no lock written. A `category` the platform does not have (`category: productivity`) is one, as is an answer's schema it would not read or a package over its limits. Before, the package was uploaded and the target refused it (`input_invalid`). The check is the import's own: the server installed with the CLI runs it (`agentrun-serve check-upload`, the upload's `{files}` body on stdin), so the two never disagree. The CLI starts it with its own node, not the server's shell launcher, so it works on Windows too. `check-upload` decodes stdin whole, so a character split between two reads stays intact.
- The refusal of an unknown category names the value it got: `category is one of engineering, security, sales, marketing, research, finance, operations, compliance, personal, not "productivity"`.
