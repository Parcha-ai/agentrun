---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's decision rows on the Timeline hold no held key: a provider's error, a source's title, an answer or a refused question that quotes one shows `[redacted]`. Each row's summary and text are redacted whole before they are cut, and an error stored cut has its last characters held back, where a key the cut split would sit. A key saved after a workflow run ended is redacted from its decision rows on the next read.
