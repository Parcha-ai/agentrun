---
packages: repo
kind: feature
---
`LiveParts.tools`, the same name -> function map as `Fakes.tools`: on `--live` the effect door (evidence, receipts, kill crossings) dispatches to it; a tool missing there runs from `fakes.tools` only when demo.json's `tools` entry says `local: "fakes"`, else the call fails `no live source for <tool>`. On fakes nothing changes.
