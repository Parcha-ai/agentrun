---
packages: @parcha/agentrun-serve
kind: fix
---
The scrubber reads a password typed in a command (`redis-cli -a`, a registry `login -p`, `mysql -p`, `npm set _authToken`, `curl -u`) through a shell lexer, `shell-lex.ts`, beside the span scans it used before. Each of the five rules cuts the union of the two: the lexer's read adds cuts and never removes one the scan makes. Passwords these forms used to leave in the text are now cut:
- after an operator inside a substitution (`redis-cli -h $(hostname; true) -a …`);
- after a substitution longer than 256 characters, or one left open on its line (`curl -H "X: $(… -u admin:…`);
- in ANSI-C quoting (`curl $'-u' admin:…`, `login -p $'…'`);
- after a backslash line continuation: between a command's arguments for all five, and between `docker` and `login` or `npm` and `config set`;
- with anything else between a program and its subcommand: a redirection (`docker >out.txt login …`), an option (`docker -D login …`, `npm -g set …`), an escaped blank;
- under a command name written quoted (`"curl"`, `'redis-cli'`, `$'curl'`), with `.exe` or `.cmd`, or after a path, a quoted one holding blanks too (`"C:\Program Files\Docker\docker.exe" login …`);
- after a non-ASCII blank (NBSP, the ideographic space, the other Unicode spaces) before or after a flag, a value or a subcommand;
- inside a substitution nested in `${…}` or `$"…"`;
- in a curl `-u` password glued to `&`, `(`, `)`, `<` or `>`, however long.

A fixed corpus (`test/fixtures/scrub-differential`) records which characters the scrubber on main cut in each row, and a test requires each of them cut still and every row's password gone, but for two rows it names with the reason (`\r` and `\n` before a name read as escapes). Once the lexer's cuts alone cover the scans' on every row, a later change can delete the scans.

The lexer's work is counted: it reads each character of a text at most 8 times, and at most 12 when commands are named inside quotes the lexer pairs. The tests assert those counts, and CPU-time ceilings on every rule they time.
