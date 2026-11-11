---
packages: @parcha/agentrun-serve
kind: fix
---
A shell under a bash policy (`tool_settings.bash.policy: "read-only"`) now runs git with its config locked down, so a read of someone else's checkout can't run a program that git config names. git reads no system or global config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`). Command-line config (`GIT_CONFIG_COUNT`, which outranks a repository's own `.git/config`) turns off core.fsmonitor and hooks, sets cat as the pager, reads no attributes (so no textconv, external diff or filter driver attaches to a path), finds a bare repository only when named (`safe.bareRepository=explicit`, against one planted in the tree), allows no transport and runs no signature program. `GIT_PAGER`/`PAGER` are cat, with no prompt, no optional lock and no lazy fetch. A run with no bash policy keeps the plain shell environment.
