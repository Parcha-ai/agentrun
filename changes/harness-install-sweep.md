---
packages: @parcha/agentrun-serve
kind: fix
---
A server restarted after a crash during a harness install no longer fails the install. A first-use install removes what an earlier install left beside it only when it can: a leftover the crashed server's orphaned npm still writes into (`ENOTEMPTY`), or one with a folder that can't be read, stays for a later sweep while the new install goes on in its own directory. The same holds for the install it replaces, and a failed install whose staging can't be removed reports why npm failed instead of why the staging stayed.
