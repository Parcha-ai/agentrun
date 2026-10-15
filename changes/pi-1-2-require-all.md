---
packages: repo
kind: ci
---
`pi-1-2` fails unless every package with a pi-family peer is in its leg: each one is built, type-checked and tested on pi 1.2.0, so a package whose ranges stop accepting 1.2 fails CI instead of leaving the leg.
