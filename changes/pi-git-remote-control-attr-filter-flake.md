---
packages: @parcha/pi-git-remote
kind: ci
---
The hostile-corpus control for `attr-filter-operator-driver` triggers the operator's clean filter with `git add --renormalize`, as `limit-git-config-filter` already does: a plain `add` skips the clean filter when the clone left the file stat-clean, so the case failed a required check on a slow runner. Both filter cases now share that trigger and run from the stat-clean state (the index newer than the file), so a trigger that depends on timing fails every time instead of now and then.
