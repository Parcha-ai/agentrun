# Recordings

Each folder here is a run recorded as `agentrun.recording/1` (its `manifest.json`, `events.jsonl` and `blobs/`), and the
build bundles every one into the gallery. A recording is written by its recorder from a clean checkout of the commit its
manifest names (`code.commit`), and nothing in it is edited by hand. The hand-cut fixtures the tests use live in
`test/fixtures/`.

| Recording | The run | Recorded with |
| --- | --- | --- |
| `reference-job` | The reference example's job (`examples/reference`) with scripted providers: no key, $0. One process. | `npm run demo:reference -- --record <dir>` |
| `ten-kills-seed21` | The same job killed ten times, at the points seed 21 picks (a model turn, the judge, a browser read, receipt filings, the supervisor before and after an outside call applied), and resumed each time. Eleven processes. | `npm run demo:kill -- --seed 21 --json --record <dir>` |

Both were recorded at `79868e54`. Their counters agree: one paid call, one judge ask, four model turns, nothing repeated
or asked twice, cost $0. The killed run adds its processes and kills, and one possible re-ask: a kill cut turn 0 after
its ask's start was committed, so the store cannot show whether the model was reached. The kill run's own ledger, which
counts at the scripted provider, shows it was asked twice there; the ledger's gates (the record matches its schema, its
citations name filed evidence, each scripted outside call ran once, every node ended, every browser session was
released) all passed. The ledger is not part of the recording.
