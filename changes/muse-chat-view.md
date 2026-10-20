---
packages: repo
kind: feature
---
The chat view can show a personal agent's run as a conversation with its browser: open a recording with `chat.html?r=<id>&muse`. A header names the agent (the host's `reference.label`, else the recording's title) with an avatar tile and its state (done, waiting for you, or working), and each step that drove a browser draws a browser card from the recording's own `frame` lines: the step's last frame in a 16:10 box, "Your agent is driving the browser", and a disabled "Take control" (a replay is over). A hold, read from the `browser.sessions` and `browser.handoff` rows alone, reads "Handed the browser over: <what was asked>" and then "Handed back · <outcome>"; nothing records who acted, so none is named. Without `&muse` a recording reads exactly as before.
