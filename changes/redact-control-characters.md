---
packages: @parcha/agentrun-serve
kind: fix
---
A saved secret now stays hidden when control characters that show as nothing (a NUL, an escape, a delete, a C1 control), or a U+FFFF that shows as a box at most, sit between its characters, whether raw, written as a JSON or Python escape, percent-encoded or as an HTML character reference, in a tool's output, a call's arguments, an answer or an imported transcript. Text with such characters and no secret in it is shown as before.
