---
packages: @parcha/agentrun-serve
kind: fix
---
A run's view, and so every runs list, is several times faster for runs with long timelines: redacting a timeline's rows no longer derives every held value's forms again for each row (its path spellings, base64 at three alignments, percent forms, hex and folded patterns). What is derived of a set of values is kept per array and derived again when the array's values change, so a value a caller adds is still cut, and what is cut is unchanged. On a store of code-review runs of about 2,500 journal writes each, one run's view went from about 3.2 s to 0.7 s, and a list of ten runs from about 22 s to 5 s.
