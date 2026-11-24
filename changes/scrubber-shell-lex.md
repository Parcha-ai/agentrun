---
packages: @parcha/agentrun-serve
kind: fix
---
The scrubber reads a password typed in a command (`redis-cli -a`, a registry `login -p`, `mysql -p`, `npm set _authToken`, `curl -u`) through a shell lexer, `shell-lex.ts`, beside the span scans it used before. Each of the five rules cuts the union of the two: the lexer's read adds cuts and never removes one the scan makes. Passwords these forms used to leave in the text are now cut:
- after an operator inside a substitution (`redis-cli -h $(hostname; true) -a …`);
- after a substitution longer than 256 characters, or one left open on its line (`curl -H "X: $(… -u admin:…`);
- in ANSI-C quoting (`curl $'-u' admin:…`, `login -p $'…'`);
- after a backslash line continuation, for every one of the five commands;
- under a command name written quoted (`"curl"`, `'redis-cli'`, `$'curl'`), with `.exe` or a Windows path;
- inside a substitution nested in `${…}` or `$"…"`.

A fixed corpus (`test/fixtures/scrub-differential`) records which characters the scrubber on main cut in each row, and a test requires each of them cut still. Once the lexer's cuts alone cover the scans' on every row, a later change can delete the scans.

The lexer's work is counted: it reads each character of a text at most 8 times, and at most 12 when commands are named inside quotes the lexer pairs. The tests assert those counts, and the CPU-time ceilings beside them stay.
