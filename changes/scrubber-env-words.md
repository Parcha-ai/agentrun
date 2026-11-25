---
packages: @parcha/agentrun-serve
kind: fix
---
The scrubber reads a call's command for an environment dump by its tokens, not by the shape of the command. It drops the line's quotes and escapes, lower-cases it, and splits it on anything but a letter, a digit, `_` or `-`. The call's whole output is one `env-dump` cut when any of these holds:
- a token runs, names or reads the environment, wherever it stands: `env`, `printenv`, `envsubst`, `environ`, `getenv`, `$_ENV`, `$_SERVER`, `compgen`, `show-environment`, `inspect` or `xtrace`. This covers `sudo -n env`, `env FOO=1 printenv A`, `ssh host env`, `kubectl exec p -- env`, `cat</proc/self/environ`, `node -p 'process["env"]'`, `jq -rn 'env.A'` and shells nested to any depth;
- a print (`echo`, `printf`, an awk program's `print`) or a here-string stands in a line that expands a variable anywhere (`$A`, any `${…}`, cmd's `%A%`);
- `set` has nothing after it, or `set` or a shell has an xtrace flag (`set -x`, `bash -x`);
- `export`, `declare`, `typeset` or `readonly` has flags only or `-p`;
- `ps` has an `e` option;
- the line is longer than is read.

An env token in an argument or a file's name is read the same way (`grep env notes.txt`, `ls src/env.ts`, a commit message naming `env`). That over-cut is kept on purpose: it fails closed.

In a transcript with no command given, a `$`, `%` or `❯` prompt line whose command prints the environment cuts everything after it up to the next such prompt or a cut marker. A multi-line value, or a `#` or `>` line inside the output, no longer ends the cut.

A run's export cuts a file's content knowing the path the run wrote, and writes only the cut path into the bundle. A `.env.<held value>` file is still cut as an env file.
