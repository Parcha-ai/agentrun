---
packages: @parcha/pi-durable-agent
kind: fix
---
A run's context reset and its summarized older context show on the Timeline with no held key in their text: the new context and the summary are words from the run, redacted by the host before the row is cut, as every other row a run's words reach.
