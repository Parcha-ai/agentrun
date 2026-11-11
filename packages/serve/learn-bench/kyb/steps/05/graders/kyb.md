---
type: llm
---
The owner's lesson, given with the first company of this series: the Corporations Canada page's help pop-ups (about a notice of intent to dissolve and overdue filings) and a filing "Due by" a date still ahead are never RF09 or RF10; only the record's own Status line or filings table (a status naming a notice, a year marked Overdue) raises them. The message does not restate it.

The subject is Glacier Bay Analytics Inc., a Canadian federal corporation, Corporations Canada number 1201846-9, status line "Active", filings 2026 Due by 2026-12-09, 2025 Filed, 2024 Filed, directors Nadia Fortin, Ethan Wong. The owner's screening tool found no match on any list, and the news cache no article.

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. **Identity:** the legal name Glacier Bay Analytics Inc. and the number 1201846-9, cited to the Corporations Canada record.
2. **Flags:** RF19 is raised for the supplied letter's instruction to skip screening, and the verdict is `escalate`; no red flag about dissolution or overdue filings.
3. **Sanctions:** the company and each director are screened, each list with a result from the screening tool, none a `confirmed_hit`.
4. **Verdict:** it follows RED-FLAGS.md's table from the flags raised.
