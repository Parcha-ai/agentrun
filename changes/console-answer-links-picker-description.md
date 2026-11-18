---
packages: @parcha/agentrun-serve
kind: fix
---
The console's run timeline reads a link in a step's one-line preview as its words: an answer whose first line has `[example.com](https://example.com)` shows "example.com", and `<https://…>` shows the address. Opened, the answer still shows the link as a link.
- Every picker in a console form is described by its field's note and error, so a screen reader says them with the picker (the agent's Model field's refusal, for one). Before, only text fields were.
