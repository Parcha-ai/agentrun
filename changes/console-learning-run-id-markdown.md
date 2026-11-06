---
packages: repo
kind: fix
---
On an agent's Learning tab, "Learned in" names the run by its short id, linked to the run, with its whole title on hover. It was the run's title cut twice. "What the next run reads" renders the notes it lists as Markdown, the way a note's body and a run's answer render, sanitized: HTML a run wrote reads as text, and a note's file name reads as its name, not a link.
