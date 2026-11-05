---
packages: repo
kind: fix
---
Console: an agent page's Learning tab carries a count when learned items wait for the owner's OK (a risky note, a held skill or workflow draft), in the warning tone, so the wait is seen without opening the tab or finding the run that kept it. The page counts them with one read of what the agent learned (the pending notes' total too, only when its notes run past the first page), and again as the tab reads, so an approve clears the count at once.
