---
packages: repo
kind: feature
---
The run viewer follows a run while it goes (`apps/viewer`, `?follow=<url>`): given a recording directory served over HTTP that grows (`events.jsonl` gaining whole lines, read from the last byte with a `Range` request; each blob in `blobs/` before a line names it; `manifest.json` written last, once the run finished), it reads what is new about once a second, places it in the format's order, and redraws every panel keeping the reader's place, with the time cursor on the newest line unless the reader scrubbed back. Kills and later processes arrive as lines like any other. When the manifest appears, the page checks the recording against the format and plays it as any recording.
