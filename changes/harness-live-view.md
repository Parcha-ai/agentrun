---
packages: @parcha/agentrun-harness
kind: feature
---
A demo on a local Chrome can hand the browser to a person: with `LIVE_VIEW_DIR` set (and declared in demo.json), the entry mounts pi-browser's live view on a loopback port and gives the browser a handoff port, so the agent gets `browser_request_handoff`, which waits until the person finishes. The request, the viewer's URL (mode 0600, nowhere else) and the person's outcome are files in `<LIVE_VIEW_DIR>/handoff/`. Without it nothing changes.
