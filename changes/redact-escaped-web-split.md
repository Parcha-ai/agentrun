---
packages: @parcha/agentrun-serve
kind: fix
---
The redactor now finds a held value written with JSON's `\uXXXX` escapes, every character or some, and withholds the text, as it does a value split by whitespace or percent encoded. Where a call's result is read only to a point, the read past that point counts an escape as the character it decodes to, so escaped whitespace there never hides the rest of a value split at it.

A web_search or web_fetch result has each string of its JSON redacted on its own, its property names now among them. A held value split across two of its strings (a name and its value included), or across its JSON and the lines after it, used to show both halves. It now withholds the result everywhere it is read: the answer the runner stores and hands the agent, a timeline row's preview and summary in the run's view and its timeline, and a read with `calls` (a template eval's grader, `calls=whole`). Each reads `[redacted]`. A held value whole in one string is still cut in place, and the result stays its JSON.
