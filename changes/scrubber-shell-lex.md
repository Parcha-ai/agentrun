---
packages: @parcha/agentrun-serve
kind: fix
---
The scrubber reads a password typed in a command (`redis-cli -a`, a registry `login -p`, `mysql -p`, `npm set _authToken`, `curl -u`) through a shell lexer, `shell-lex.ts`, beside the span scans it used before. Each of the five rules cuts the union of the two: the lexer's read adds cuts and never removes one the scan makes. Passwords these forms used to leave in the text are now cut:
- after an operator inside a substitution (`redis-cli -h $(hostname; true) -a …`);
- after a substitution longer than 256 characters, or one left open on its line (`curl -H "X: $(… -u admin:…`);
- in ANSI-C quoting (`curl $'-u' admin:…`, `login -p $'…'`);
- after a backslash line continuation: between a command's arguments for all five, and between `docker` and `login` or `npm` and `config set`;
- with anything else between a program and its subcommand: a redirection (`docker >out.txt login …`), an option (`docker -D login …`, `npm -g set …`, `npm config --global set …`, any number of options between `config` and `set` within the command's read, which ends 1024 to 3072 characters past the command's name), an escaped blank;
- after `c`, npm's and pnpm's alias of `config` (`npm c set //registry/:_authToken …`);
- in a registry login's `-p` with the password glued on (`docker login -p<pw>`);
- under a command name written quoted (`"curl"`, `'redis-cli'`, `$'curl'`), with `.exe`, `.cmd`, `.bat` or `.ps1` in any case (`Docker.exe`), or after a path: a quoted one holding blanks (`"C:\Program Files\Redis\redis-cli.exe" -a …`) or a relative one (`.\redis-cli.exe`). Inside such a path a backslash is a separator, not the start of an escape (`\r`, `\n`). A quoted path ends at its closing quote on the line, and where a path keeps an escape, the same text read with every escape blanked stands beside it, so a path read never leaves what the escape read cuts;
- after a non-ASCII blank (NBSP, the ideographic space, the other Unicode spaces) before or after a flag, a value or a subcommand;
- inside a substitution nested in `${…}` or `$"…"`;
- in a curl `-u` password glued to `&`, `(`, `)`, `<` or `>`, however long.

A fixed corpus (`test/fixtures/scrub-differential`) records which characters the scrubber on main cut in each row, and a test requires each of them cut still and every row's password gone, but for two rows it names with the reason (a backslash before a name outside a Windows path, `\redis-cli`, reads as an escape). Once the lexer's cuts alone cover the scans' on every row, a later change can delete the scans.

The lexer's work is counted: it reads each character of a text at most 8 times, and at most 12 when commands are named inside quotes the lexer pairs. The readers hand out one command's words at a time, so what they hold stays one command's however long the text. The tests assert those counts, bound each timed rule's CPU against main's span scan for it, timed in the same call, and bound its wall time, after a full collection, against its own on a quarter of the text.
