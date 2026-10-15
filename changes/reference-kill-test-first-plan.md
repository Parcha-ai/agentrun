---
packages: repo
kind: ci
---
The reference kill test no longer claims that the same seed lands every kill at the same place: under load, later landings depend on the order concurrent work takes inside a process. It asserts what is true: the same seed draws the same first kill's plan, another seed draws another, and every ledger check and gate passes on each run.
