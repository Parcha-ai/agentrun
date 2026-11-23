---
packages: @parcha/agentrun
kind: fix
---
`agentrun template eval DIR --case NAME` refuses a case the package does not have (no folder `evals/NAME`) itself, at once, before it starts the server's launcher, with the server's own words and exit 2. The server still checks each case it runs whole.
