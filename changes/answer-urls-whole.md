---
packages: @parcha/pi-durable-agent
kind: fix
---
The agent's answer and its text rows on the Timeline show their URLs whole, as the answer itself does: a console link keeps its `#/runs/<id>` and query, and a held key in a URL reads `[redacted]`. URLs from what the model read (a tool's result, a page's title, a call's arguments) and its thinking are still shown without their query values and fragment.
