---
packages: repo
kind: ci
---
**The hero example's cost check allows the fold's 1e-8 rounding**
- The fold rounds a run's cost to 1e-8, so a priced run's total can land a hair under the raw sum of the eyes' charges (0.009632 for 0.009632000000000002). Beat 3 compared them exactly and failed on such runs; it now allows the 1e-9 the look cost's check already allows, and a test plants those charges.
