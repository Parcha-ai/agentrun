# Recordings

The hosted gallery's recordings are not in git. The Pages job unpacks them here from one tar on the release tagged
`gallery`, which `../recordings.lock.json` names with its SHA-256 and the gallery's ids in order
(`scripts/recording/gallery.mjs fetch`), and the build bundles every one into the gallery. Each id is the name of the
example folder whose run it is (`examples/<id>`): the gallery shows agent runs only.

Each recording is a run recorded as `agentrun.recording/1` (its `manifest.json`, `events.jsonl` and `blobs/`), written by
its recorder from a clean checkout of the commit its manifest names (`code.commit`), and nothing in it is edited by hand.
The scripted runs the tests read, the reference job (`reference-job`) and the same job killed ten times
(`ten-kills-seed21`), are kept with the test fixtures (`../test/fixtures/`).

Only this README is in git here; anything unpacked beside it is ignored.
