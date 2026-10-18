---
packages: repo
kind: fix
---
**`apps/viewer`: the gallery and a replay's header name no process or kill**
- The killed and resumed reference job (`ten-kills-seed21`) leaves the gallery and is kept with the test fixtures
  (`apps/viewer/test/fixtures/`), where the tests that read a killed run beside the clean one find it.
- The gallery's line reads "Replays a run recorded as agentrun.recording/1.", each run in its list is followed by its
  model alone, and a replay's header no longer counts processes and kills. The counters stay under `?debug=durability`.
