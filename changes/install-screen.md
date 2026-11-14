---
packages: @parcha/agentrun-serve
kind: fix
---
The console's template install and Apply screens say what a package does before you take it: each typed run input (its label and name, what it takes, Required or Optional, its description, in the run form's words), its eval cases by name, and on the install screen each MCP need with the reason the template gives and the tools it asks for. A required text field sent empty (`""` where `minLength` asks for more) is now refused as missing (`input.company is required`, reason `missing`), so the run form says "Company is required"; an optional field or a list item keeps its length issue. A source path with a `%` that starts no escape (`github:…/k%ZZb`) is refused by a sentence that names it, and a `github:` source's percent escapes are read as in a tree URL. An install refusal shows its sentence once.
