---
packages: repo
kind: fix
---
Console: an agent made here and run straight away in the Playground shows its name in the run panel's header on its first run, not its id. A run's short label (the run page's header, the Playground's run panel, a learned note's run) is now the last 8 characters of its id, so two runs started in the same minute no longer share a label. The file viewer also closes on a click on the dimmed backdrop around the file, as well as on its X and Escape; a click inside it, or a selection dragged out of it, keeps it open.
