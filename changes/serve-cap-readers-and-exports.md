---
packages: @parcha/agentrun-serve
kind: breaking
---
`@parcha/agentrun-serve` no longer exports `ASK_TOOL`, `ToolEntry`, `FauxHelpers`, `TokenSource` or `banner`, which nothing outside the server called. A program that imported one defines its own: `ASK_TOOL` is the string `"ask_person"`, and `banner` built the CLI's start-up lines. `startServe`, `serveWithRunner`, `capabilities`, `TOOLS` and `BOUND_TOOLS` are unchanged.
