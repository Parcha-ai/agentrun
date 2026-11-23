---
packages: @parcha/agentrun-serve
kind: fix
---
The redactor now finds a held value written with JSON's `\uXXXX` escapes, every character or some, and withholds the text, as it does a value split by whitespace or percent encoded.

A web_search or web_fetch result read with `calls` (a template eval's grader, a timeline read with `calls=whole`) has each string of its JSON redacted on its own. A held value split across two of its strings, or across its JSON and the lines after it, used to show both halves. It now withholds the result, which reads `[redacted]`. A held value whole in one string is still cut in place, and the result stays its JSON.
