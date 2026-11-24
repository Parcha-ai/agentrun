---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: feature
---
A scrubber for what leaves the machine: `agentrun scrub <run>` counts what a share of a run would cut, per rule, and never prints a value. The rules live in `secret-rules.ts` beside the existing cut (`secret-cut.ts`), and `scrub(text, { mode })` runs one rule set two ways: `count` (how many, of what kind, where) and `cut` (the text with each match replaced). Cut mode fails closed: any error gives `{ ok: false }` and no text.
- Every rule is anchored: a known key format (the learning guard's shapes and secretlint's preset), a value the server holds, or a label beside the value (`PGPASSWORD=`, `sshpass -p`, `mysql -p`, `--password`, `Authorization:`, `curl -u`, a key-named variable). No rule fires on randomness alone.
- New cuts: passwords typed in commands, whole dumps (`env`/`printenv` output, `.env*` files, `~/.ssh` contents) dropped as one marker, credential files (`.netrc`, `.pgpass`, docker and kube configs), emails, private IPs (RFC 1918, CGNAT, ULA), and home paths, whose user segment becomes `<user>` (`/root` names no one and stays).
- Each cut carries its rule, its kind (`format`, `held`, `dump`, `label`, `personal`) and whether a person may restore it: label and personal cuts may be restored, a known-format key, a held value or a dump never. `keep` restores only the first two.
- A JSON-escaped text gets the same cuts as the text it encodes, up to three levels deep, and a cut never splits an escape. Placeholders and references (`$VAR`, `$(cmd)`, `op://...`, `<your-key>`, `REPLACE_ME`, `sk-...`) are never cut.
- After cutting, the result is checked again for a held value or a known key format; cut mode fails closed if one is left, and `agentrun scrub` says a share of the run would be refused. Long texts are read in overlapping pieces, never truncated.
- A key longer than any real one (a 70,000-character `sk-` key, say) is now cut whole, and the share goes through; it used to make the share refuse.
- A quoted password that holds a shell operator (`redis-cli -a 'pa&ss'`) is cut whole, and so is a query or form password longer than 1,024 characters (`?new_password=…`); before, part of each stayed visible.
- `packages/serve/test/fixtures/scrub-negatives/` is a frozen set of 489 things that look like secrets and are not (git SHAs, UUIDs, content hashes, lockfile integrity strings, base64 images, code, prose, the shapes a sweep of real runs found cut wrongly). A cut in any of them fails CI.
