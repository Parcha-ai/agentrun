---
packages: repo
kind: feature
---
The hero example gains a `--chrome` path (a local Chrome on the job's own pages, with no network) and a `--live` path (Browserbase on the real dashboards, the eyes and the lead on a gateway's OpenAI-compatible API with a placeholder key and no provider key; it refuses without `HERO_LIVE_SPEND_OK=1`). With either, each browser session is screencast into the recording with `@parcha/pi-browser/recorder` and leaves one video and its index at export. `--see` is reserved for `vision.see` and refuses until it ships.
