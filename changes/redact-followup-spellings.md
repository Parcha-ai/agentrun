---
packages: @parcha/agentrun-serve
kind: fix
---
A saved secret now stays hidden in more spellings: HTML references such as `&amp;`, zero-padded or unterminated numeric references, a "+" between halves split across strings, and a single-quoted dict. A run whose learned workflow start was withheld still records that workflow's name. The run graph now says when its node states are withheld. A console polling a run no longer re-checks unchanged tool arguments on every read.
