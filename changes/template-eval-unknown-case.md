---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
`agentrun template eval DIR --case NAME` now refuses a case the package doesn't have (no folder `evals/NAME`) by itself, before it starts the server's launcher, and exits 2. It uses the server's wording, and both list the package's cases in name order: the server's refusal now sorts them itself instead of depending on the order the folder listing comes back in. The server still checks each case it runs. One change: when a package is malformed and a case name is also mistyped, the case error now comes first, and the package's problems show once the case name is right.
