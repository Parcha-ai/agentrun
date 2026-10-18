---
packages: repo
kind: ci
---
The verify job's time limit is 40 minutes (it was 25). A run on main takes 17 to 24 minutes today, so a slow runner was cut at the limit and the check failed without a test failing.
