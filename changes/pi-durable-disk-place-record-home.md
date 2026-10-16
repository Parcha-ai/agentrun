---
packages: @parcha/pi-durable-disk
kind: feature
---
**`archilPlace.recordHome`: a runner on a box records into the run's disk, and the place brings the recording home**
- `Place.recordHome` (`PlaceRecordHome`): `dir(attempt)` is where that attempt's runner records, and
  `bringHome(into, { final })` brings what it recorded into the supervisor's recording directory. `archilPlace` has
  it when its control can list (`RecordControl`, as `archilControl` does); `localPlace` has none, since its runner
  writes the supervisor's directory itself.
- `dir(attempt)` is `<root>/record/<attempt>`, inside the run's directory. `bringHome` reads it over S3 (list and get,
  never the run's claim). Blobs come first, hash-checked and written whole; then the new whole lines of each
  `.spool/*.jsonl` segment, with an offset per file name kept as what `into` already holds, so it is idempotent across
  calls and processes.
- With `ensure.create`, each start first makes the EMPTY `signals/`, `record/<attempt>/.spool/` and
  `record/<attempt>/blobs/` over the control, owned by the run user (mode 0755), while no delegation holds the run. A
  directory made by path on an Archil mount was seen to refuse file creates. Every file in them stays the runner's; a
  refused put fails the start with `DIRS_REFUSED`.
- Box receipts: `HostDriver.box(handle)` (`HostBox`) and `PlaceStatus.boxes`. `archilPlace.status()` lists a receipt
  for each box it started, released ones included: provider, kind, `from`, `to`, the published list price per second,
  and its `source` (page and date read). `daytonaHost` reports its sandboxes, priced at `DAYTONA_LIST_PRICES`
  (https://www.daytona.io/pricing, read 2026-10-16), with the "first 5 GiB free" applied to disk (the footnote's
  placement is ambiguous). A box of unknown size has no price, nor does a box with a GPU, which the page prices per
  model (`daytonaUsdPerSecond`). `localPlace` reports none.
- Failures carry codes (`PlaceError`). `BLOB_MISMATCH` is thrown after everything else came home. `CARRY_FAILED` is
  thrown for a list or get that fails, and on `final` for a line whose blob never landed. `BOX_GONE` is never thrown
  by this place: the recording lives on the disk, which outlives the box.
