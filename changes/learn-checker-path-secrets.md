---
packages: @parcha/agentrun-learn
kind: fix
---
The checker now refuses a secret in a name the run picks, not only in a file's text: each path the run adds or changes, and the branch's name, is read for text shaped like a secret (`secret_shape`) and for a value the host named as secret (`secret_value`), plain or encoded. A skill or workflow folder named for a value in hex, or like an `sk-` key, is refused on its path; a deleted path is main's and is not read. A value that holds a quote, a backslash or a control character is now also found as JSON writes it (`\"`, `\\`, `\n`, `\u0001`). The CLI's redaction covers the forms the checker finds as they stand, hex in any case and base64 included, so a refused path is printed with its value redacted in text and JSON; it redacts each printed field on its own, and a field that still holds a value in another form (percent encoded, split by whitespace) prints whole as `[redacted]`.
