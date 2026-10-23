# Page-action fixtures

Six recordings of `browser.sessions` durable lines only, for the browser's page actions on the counters strip
(RECORDING.md section 6, draft 25). They were recorded from pi-browser's durable kill rig: its real tools on the fake
backend with a scripted model, killed with SIGKILL, so every field is one pi-browser writes, including `tool`, `prior`
and `toldBy`, which reach this repository's `packages/pi-browser` at a later sync. `expected.json` beside each says what
the fold must read. They were checked against an independent fold of the same rule before this viewer's.

| fixture | what happens | expected |
|---|---|---|
| `1-mid-click` | process 1 journals the submit, it reaches the page (`finished`), and the kill cuts it before pi saves its answer; process 2 refuses the identical submit (`effect_unknown`, no entry), looks and settles | repeated 0, asked twice 0 |
| `2-repeated` | as 1, then process 2 sends the identical submit again after the look | repeated 1 |
| `3-asked-twice` | no kill: the identical submit is dispatched twice in process 1, and the first finished | asked twice 1 |
| `4-possible` | process 1's submit is held at the driver and killed: neither `finished` nor a sent row; process 2 refuses it, looks, and sends it again | possible 1 |
| `5-export-only` | fixture 2's store exported after the run: one line per conversation, its latest revision, no `t` | not measured |
| `6-prior-chain` | process 1's submit is cut; in process 2 another run tells it and is cut, carrying it as `prior`; process 3 tells both | 0, 0, 0 (two keys, each dispatched once) |

Two approximations of the rig: a snapshot line carries the highest commit already in the file rather than the store's
latest, and `gen` is the process's own count (the rig has no `agentrun.driver`). The page-action fold reads neither.
