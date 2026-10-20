---
packages: repo
kind: ci
---
The release workflow's publish job may run 90 minutes (it was 45): enough for its `npm run check` (about 27 minutes) and one registry wait per package (up to 20 minutes each).
