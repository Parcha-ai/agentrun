---
packages: @parcha/agentrun-serve
kind: fix
---
Protect unsaved agent definition requests when navigating away or reloading. Form and JSON edits remain guarded after failed saves, while confirmed saves clear only the submitted changes.
