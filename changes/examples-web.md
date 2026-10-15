---
packages: repo
kind: feature
---
A runnable example of one agent behind a tiny web page (`examples/web`): a job history, a live run page with chat, grouped steps, files and the agent's browser, and a hand-over where the agent asks the person to sign in through the browser's live view, all on pi-durable-disk's per-run door. The server is one file of Node's `http` with a copy of the timeline module that turns pi's entries and events into timeline rows; its tests run offline.
