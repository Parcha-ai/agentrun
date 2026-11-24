---
packages: @parcha/agentrun-serve
kind: fix
---
A browser `run` call the browser refused before it ran (pi-browser's typed failure `code: "refused"`, such as code sent to a local Chrome that takes only actions) now reads on its Timeline row as what the browser refused: "The browser refused the code to open iana.org/help/example-domains: run code is not available on this browser …". Before, it read "Opened iana.org/help/example-domains failed: …", as if the page had failed to open. Any other failure of the call reads as before. `registerLabel`'s `saysFailure` also takes a test of the errored result, for a tool whose label says only some of its failures.
