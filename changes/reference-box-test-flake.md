---
packages: repo
kind: fix
---
The reference entry's boxes test no longer flakes under load: the install tool's first command now outlasts any scheduling delay (the planned box loss always beats it), so the first box is always lost and the second always runs; before, a slow loss let the first command finish and the second box was never made.
