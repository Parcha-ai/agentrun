---
packages: repo
kind: fix
---
A run's Report reads an answer's closing JSON object as fields (labels, nested groups indented, lists, long values wrapped in place, null as "—"), with "Show raw JSON" for the object pretty-printed and wrapped. Code blocks in a report, and a workflow run's output, wrap inside their box instead of running off the page.
