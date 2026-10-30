---
packages: repo
kind: ci
---
The `vision-binaries` job's time limit is 20 minutes, from 15, measured: over 44 jobs its suite took a median of 11.6 minutes, 13.7 at the 90th percentile and 14.5 at the slowest pass, and two runs were cut at 15 with no failed step. One file, `packages/pi-vision/test/binaries/report-skill.test.mjs`, is 784 s of the 805 s suite; once it is split, the limit goes back to 15.
