---
packages: @parcha/agentrun-serve
kind: ci
---
`barrier-box-loss.test.mjs`'s workflow case kills the run once the effect's line is in its file, not once the file exists: the effect opens the file and then writes its line, so a kill between the two left it empty and the case failed with `'' !== 'first\n'` (seen on CI run 42435209304).
