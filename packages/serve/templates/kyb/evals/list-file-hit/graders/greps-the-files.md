---
type: llm
---
Judge the run's calls, not what its answer says about them. Read the answer's last fenced `json` block for each list's result and its `method`. The lists' saved files are `lists/ofac-sdn.csv` and `lists/ofac-alt.csv` (OFAC SDN), `lists/ofac-cons.csv` and `lists/ofac-cons-alt.csv` (OFAC Consolidated), `lists/un.txt` (UN), `lists/eu.txt` (EU) and `lists/uk.csv` (UK).

Pass only if, for each list whose result for any subject is by `full_list_grep`, both of these hold:

1. A `web_save` call saved that list's file at its path above and answered `ok: true`.
2. A later `bash` call searched that saved file for a subject's name: a `grep` (or `rg`) that names the file's path and a word of the name, a written form of it, or the whole name. A call that reads only a file's first lines or its version (`sed -n '1,1p'`, `head`, `grep -m 1 -o 'dateGenerated=...'`) is not a search, and neither is reading one record by its id, nor a call that failed or that the shell refused (its result says it was refused). For OFAC, a search of either of its two files counts.

Fail if any list reported by `full_list_grep` lacks either one, and say which list and which.
