---
packages: repo
kind: feature
---
**`apps/viewer`: the hosted gallery's recordings come from a release asset, and a public replay draws no dollar figure**
- The gallery's recordings leave git. `apps/viewer/recordings.lock.json` names one tar on the release tagged `gallery`,
  its SHA-256 and the gallery's ids in order, each `{ id, poster?, looks? }` (`looks`: the keys of looks the run filed on
  one image, which its card shows with their boxes). The Pages job fetches it before the build
  (`node scripts/recording/gallery.mjs fetch`, with the job's own token) and unpacks nothing unless the tar hashes to
  the lock, holds only those ids' manifests, lines and blobs as plain files, no recording is over 80 MB and the gallery
  not over 300 MB, raw, each poster is an image its recording holds, and each id, listed once, is the name of the example
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
- The gallery shows agent runs only: the scripted reference job leaves `apps/viewer/recordings/` for the test fixtures
  (`apps/viewer/test/fixtures/reference-job`), where every test that read it now finds it. In git, `recordings/` holds
  only its README.
- A page, an SVG or a script in a recording (an agent's report, draft 41) is published as `<name>.txt`: opened straight on
  the gallery's site it is plain text and runs nothing, while the viewer reads it into its sandboxed frame. The gate
  refuses a published blob that would open as a page under its own name.
- The viewer's page carries a Content-Security-Policy (only its own files run or load; data: and blob: pictures and
  videos), its styles in `viewer.css`; PDF.js opens every PDF with `isEvalSupported: false`.
