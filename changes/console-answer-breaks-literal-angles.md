---
packages: repo
kind: fix
---
The console shows what an agent wrote as it wrote it. A single line break in an answer, a note or a file is a line break: an answer asked for in three lines reads as three lines, where it read as one. Lists, code blocks and paragraphs are unchanged. The timeline's Answer row, which shows the answer's first line, ends it with "…" when the answer has more. Text in angle brackets that is no HTML the console keeps reads literally: "Customer: <name>" and "Amount: $<amount>" in an answer, a learned note or a skill, where the tag was dropped and they read "Customer: " and "Amount: $". A `<script>` an agent quotes reads as its text and never runs. HTML the console keeps (`<b>`, `<br>`, `<img>`, a table and its cells) is still HTML, and a template whose first line is `<name>` keeps its lines, and the sanitizer still checks everything.
