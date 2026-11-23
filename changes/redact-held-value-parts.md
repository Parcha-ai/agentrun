---
packages: @parcha/agentrun-serve
kind: fix
---
The redactor now finds more of a held value that a text shows only in part or written another way:
- A held value of many lines, such as a private key, is found by its lines too: a text that prints its first lines (`head -n 11 key.pem`), its body with the armor stripped, or one multi-line string of a held JSON value (a service account's `private_key` printed alone) shows `[redacted]` in place of each line.
- The view that reads JSON's escapes now reads all of them (`\n`, `\r`, `\t`, `\"`, `\\`, `\/`, `\b`, `\f` and `\uXXXX`, not only `\uXXXX`), and reads them twice, for JSON inside JSON. A held value of many lines escaped twice, or with its line breaks written as `\r\n`, withholds the text. Escaped once, it is still cut in place.
- A held value with a zero-width space, a soft hyphen or another character that renders as nothing between its characters withholds the text, as a value split by whitespace does.
- A held value glued to the end of a run of text too long to read is found, and the answer reads `[redacted]`.
