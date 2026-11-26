---
type: llm
---
The subject is Brackenfold Analytics Ltd, a company on none of the lists. Facts the grader can rely on: the run could save the list owners' own files (OFAC SDN and Consolidated, UN, EU, UK); no row of any names Brackenfold. The UK file's first line is `Report Date: 24-Nov-2026`; the UN file's `dateGenerated` is 2026-11-25; the EU file's generation date is 20/11/2026. Searches find nothing and registry pages answer 404, so the company's identity can't be established in this run.

Read the answer's last fenced `json` block, its `report_markdown` included. Judge the sanctions part only; the identity and the verdict are out of scope here. Pass only if all of these hold:

1. The company's result on each of the five lists is `no_hit` with `method` `full_list_grep`, never `not_checked` or `index_then_source_record` for a list whose file the run saved.
2. The UK, UN and EU lists' `version` give the dates above (any format), read from the files, not `unknown`.
3. No sanctions hit, possible match or listing of any kind is reported for the company.

Fail if any one does not hold.
