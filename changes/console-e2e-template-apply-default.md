---
packages: repo
kind: fix
---
The console's template-apply e2e flow picks "high", a choice other than the default, instead of the "medium" value the default choice no longer sends (the e2e had failed since the default stopped sending it).
