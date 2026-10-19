# Recordings

Each folder here is a run recorded as `agentrun.recording/1` (its `manifest.json`, `events.jsonl` and `blobs/`), and the
build bundles every one into the gallery. A recording is written by its recorder from a clean checkout of the commit its
manifest names (`code.commit`), and nothing in it is edited by hand. The hand-cut fixtures the tests use live in
`test/fixtures/`.

| Recording | The run | Recorded with |
| --- | --- | --- |
| `reference-job` | The reference example's job (`examples/reference`) with scripted providers: no key, $0. One process. | `npm run demo:reference -- --record <dir>` |

It was recorded at `51c178bc`, after the recorder stopped keeping a browser session's live-view URL: one paid call, one judge ask, four model turns, nothing repeated or asked twice, cost
$0. The same job killed ten times and resumed, `ten-kills-seed21`, is kept with the test fixtures (`test/fixtures/`).
