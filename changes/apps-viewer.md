---
packages: repo
kind: feature
---
**New app, `apps/viewer`: a static player for runs recorded as `agentrun.recording/1`**
- It plays a recording (its format is `apps/viewer/RECORDING.md`) from a gallery built with it (none yet), a URL beside
  the page, or a folder dropped on the page. One classic script with no dependency, so it opens from `file://`;
  Cloudflare and Vercel deploy configs serve it as static files.
- The timeline draws a band per process from the supervisor's lines with each kill labelled, a restore after a box died
  (accepted only with its `transport.moves` record, every move record's `head` checked), the calls and the model turns.
  A scrub stops only between commits, never inside a process's snapshot, and equals a fresh reduce to that point.
- The counters strip folds durable lines only: paid calls made (a lost branch's included), repeated and asked twice per
  call (an effect's applied calls, or an agent's paid call by its receipt key; an effect that reports no calls shows
  repeated as not measured), unknown, judge asks, model turns (an aborted entry is not one), re-asks from the store's
  `pi.live` (proven or possible), processes, kills, and cost, unknown when any part is (model, judge, browser sessions,
  vision looks). A recording with no durable line shows every count as not measured, never 0.
- Panels follow a pure `accepts`, `reduce`, `view` contract (`apps/viewer/PANELS.md`); focus is a view input, and an
  extension's panel shows before the shell's own two. A manifest's `chapters`, `baseline` and `providers` are read.
  `?at=`, `?cite=` and `?focus=` links. A recording's file opens in a tab only when its type is passive.
- `npm run test:viewer` (in `npm run check` and CI) typechecks it and tests it against a fixture cut from a real killed
  run, a restore built line by line and a real 30-kill storm, and opens the build from `file://` in Chrome when there is
  one.
