---
packages: repo
kind: feature
---
**`apps/viewer`: the manifest's job and store**
- A manifest's `job` (the job that ran, a JSON blob) and `store` (the run's store at its end, a SQLite blob, with the
  commit and generation it was taken at), from the format's draft 24, are linked in the header: the job opens in a tab,
  the store downloads (`.sqlite` is never opened in the viewer's page).
- Both count among the blobs a recording names, so a recording opened from a URL fetches them, and the viewer's format
  check notes either one missing from `blobs/`.
