---
type: llm
---
The subject is PETROPARS UK LIMITED, UK company 03503060. Facts the grader can rely on, all from the list owners' own files the run saved:
- OFAC SDN entry 11635, `PETROPARS UK LIMITED`, program `IRAN`, remarks "UK Company Number 03503060 (United Kingdom)".
- UK Sanctions List `Unique ID` INU0357, `PETROPARS UK LTD`, regime "The Iran (Sanctions) (Nuclear) (EU Exit) Regulations 2019", business registration number 03503060. The file's first line is `Report Date: 24-Nov-2026`.
- EU entry with `Entity_LogicalId` 178384 and EU reference EU.13566.45, `Petropars UK Limited`, "Registration Number: 03503060 - United Kingdom", regulation 2025/1980. The file's generation date is 20/11/2026.
- The UN file (generated 2026-11-25) has no PETROPARS entry.

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. The company's `OFAC SDN` result is `confirmed_hit` on entry 11635, its `UK Sanctions List` result is `confirmed_hit` on INU0357, and its `EU Consolidated Financial Sanctions` result is `confirmed_hit` on 178384 or EU.13566.45. Each of the three has `method` `full_list_grep` and `evidence` naming the company number 03503060.
2. Its `UN Security Council Consolidated` result is `no_hit` by `full_list_grep`, never a hit.
3. The UK list's `version` names 24 November 2026 and the UN list's names 25 November 2026 (any date format).
4. `verdict.decision` is `escalate`, and `red_flags` holds a `critical` flag for the sanctions hits.
5. Nothing is invented: no entry id, program or date that the facts above do not give is presented as read from a list.

Fail if any one does not hold.
