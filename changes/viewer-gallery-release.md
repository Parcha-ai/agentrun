---
packages: repo
kind: feature
---
**`apps/viewer`: the hosted gallery's recordings come from a release asset, and a public replay draws no dollar figure**
- The gallery's recordings leave git. `apps/viewer/recordings.lock.json` names one tar on the release tagged `gallery`,
  its SHA-256 and the gallery's ids in order, each `{ id, poster? }`. The Pages job fetches it before the build
  (`node scripts/recording/gallery.mjs fetch`, with the job's own token) and unpacks nothing unless the tar hashes to
  the lock, holds only those ids' manifests, lines and blobs as plain files, no recording is over 40 MB and the gallery
  not over 150 MB, each poster is an image its recording holds, and each id, listed once, is the name of the example
  folder whose run it is (`examples/<id>`), as the run's own manifest says: one recording per example, so a re-take
  replaces its id. `gallery.mjs pack` writes the tar and the lock's SHA-256.
- The gallery's gate reads a card on an index entry (`{ title, line?, poster?, rank? }`) and refuses a poster that is
  not an image the recording holds.
- A part of the inspection view that draws a dollar figure is marked `cost` and drawn only with `?debug=cost` or
  `?debug=durability`, under Receipts too: the strip's cost, the vision panel's spend and a receipt's price, and the
  transport panel's cost.
- The vision panel no longer says the eyes have not looked when live lines tell of a look no store document filed: it
  lists the look (a native one as the lead's own) under what live lines told, as never filed once the run delivered,
  and counts nothing from it.
