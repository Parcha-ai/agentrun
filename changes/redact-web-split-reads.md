---
packages: @parcha/agentrun-serve
kind: fix
---
Two more web_search and web_fetch answers with a held value split across two of their strings are now withheld. The runner stored one as it came when its redactor did not list the values it holds and the answer's strings ran past 8,192 characters; it now stores `[redacted]`. A timeline row's preview, a read with `calls` and the stored answer showed one whose halves sit side by side only in the order the answer was written (a property name of digits alone, which a JSON object reads first, or a name written twice, whose first value only the text keeps); each now reads `[redacted]`.
