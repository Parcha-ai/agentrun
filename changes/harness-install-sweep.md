---
packages: @parcha/agentrun-serve
kind: fix
---
A server restarted after a crash during a harness install no longer fails the install. A first-use install removes what an earlier install left beside it only when it can: a leftover the crashed server's orphaned npm still writes into (`ENOTEMPTY`), or one with a folder that can't be read, stays while the new install goes on in its own directory. The same holds for the install it replaces, and a failed install whose staging can't be removed reports why npm failed instead of why the staging stayed. What stays is swept later: a server that finds a harness installed (at its start, or when an agent's save or a run looks) removes what earlier installs left beside it, under the install's hold and never while another process installs, so a leftover doesn't stay on the disk once its npm has finished. That npm is never killed by its process id.
