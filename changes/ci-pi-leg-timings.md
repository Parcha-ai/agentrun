---
packages: repo
kind: ci
---
A pi leg (`scripts/pi-leg.mjs`) now records how long each of its steps took: each install, the build, and each package's typecheck and test, as `ms` in its report. It ends by printing them slowest first, with their total. A leg that runs long then names the packages and steps that grew, instead of only reaching the job's time limit.
