---
packages: @parcha/agentrun-serve
kind: fix
---
The scrubber reads a password typed in a command (`redis-cli -a`, a registry `login -p`, `mysql -p`, `npm set _authToken`, `curl -u`) through one shell lexer, `shell-lex.ts`, instead of a reader per case. Each rule now walks the command's words. Passwords these forms used to leave in the text are now cut:
- after an operator inside a substitution (`redis-cli -h $(hostname; true) -a …`);
- after a substitution longer than 256 characters, or one left open on its line (`curl -H "X: $(… -u admin:…`);
- in ANSI-C quoting (`curl $'-u' admin:…`, `login -p $'…'`);
- after a backslash line continuation, for every one of the five commands.

The lexer's work is counted: it reads each character of a text at most 8 times, whatever the text repeats, and the tests assert that count instead of a CPU time.
