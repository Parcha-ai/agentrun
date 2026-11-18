---
packages: @parcha/agentrun-serve
kind: feature
---
The agent editor's Computer step has a Recording switch for a desktop, a phone or a browser: on, it saves `computer.record: true` (a video of each run), with a note that it records everything on the screen, including what a person types after taking over and any password shown. A switch of provider, or of kind to another that records, keeps the recording on; a switch to a sandbox or to no computer turns it off and says so on that kind's card. Before, any switch dropped `record`. A server without ffmpeg refuses the save, and its words show in the Computer step.
