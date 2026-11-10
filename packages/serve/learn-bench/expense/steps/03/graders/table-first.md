---
type: regex
pattern: '^\s*\|\s*Category\s*\|\s*Count\s*\|\s*Total\s*\|\s*\n\s*\|[\s:|-]+\|'
flags: i
---
The answer opens with the table: its header is `| Category | Count | Total |`, then the separator row. Nothing comes before it.
