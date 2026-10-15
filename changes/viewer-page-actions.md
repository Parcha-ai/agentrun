---
packages: repo
kind: feature
---
**`apps/viewer`: the browser's page actions in repeated and asked twice**
- The counters strip folds the browser's replay-unsafe page actions (RECORDING.md section 6, draft 25) from the session
  records' `pendingEffect` entries and the `prior` ones they carry, per `(conv, tool, codeSha)`. A dispatch after one
  that reached the page (`finished`, or a sent row that was not denied) is one extra: in repeated when its process is
  later, in asked twice when it is the same. A dispatch after ones that never showed reaching the page is possible,
  shown as "+ N possible" beside repeated and never counted.
- A recording whose `browser.sessions` lines all carry no `t` (a bare export's) shows page actions not measured, and
  repeated and asked twice read "not measured" rather than 0 when nothing else measured adds to them.
- `apps/viewer/RECORDING.md` names that signal in the format's own words: a recording whose `browser.sessions` lines all
  carry no `t` (a bare export's) shows page actions not measured, never 0.
