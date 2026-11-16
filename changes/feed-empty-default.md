---
packages: @parcha/agentrun-serve
kind: fix
---
A template whose feed trigger takes `urls` from an array parameter with `default: []` now passes validation and reads. Apply already skipped such a trigger with a `triggers.<i>` warning; validate-template and readPackage refused it with "urls is a list of 1 to 20 feed URLs", and now agree with apply.
