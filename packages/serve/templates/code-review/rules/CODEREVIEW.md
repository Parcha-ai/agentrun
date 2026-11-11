# CODEREVIEW.md: the reviewer's baseline

Read on every review, before the repository's own `CODEREVIEW.md` (root or `docs/`, from the base branch), which adds
to it. The last section is the starter for a repository's file.

## Checklist: ask of every changed function

Answer each yes or no. Yes means a bug, and needs a changed line and a named failure. "Not enough information" is no,
unless one named fact elsewhere would decide it: then it is a candidate to prove, with that fact written down.

1. Did a contract change (sync to async, a nullable return, a new required argument, an error now thrown or now
   swallowed, a default or fallback removed) while a caller still relies on the old one?
2. Did a refactor drop a case the old code handled (a guard, a fallback, an `else`, an `a ?? b` split into branches)?
3. Does the callee ignore an option, flag or field its caller now passes, or does a wrapper call itself instead of
   what it wraps?
4. Is a missing or unknown value turned into a valid-looking one (`?? 0`, `|| ""`, a default) where callers must tell
   the two apart?
5. Is a cache, store or record written on the failure path, or left half-written when a later step throws?
6. Is state read before an `await` or a lock written back after it, so a concurrent change is lost?
7. Does a value break at a boundary: serialization, a unit (seconds and milliseconds), an encoding, an off-by-one in an
   index, slice or loop bound, an order assumption?
8. Does untrusted input (request, PR text, file name, model output) reach a shell, query, path, URL or prompt without
   the check the neighbouring code makes; is a secret or identity compared or shown unsafely (case, timing, a cut
   before redaction)?
9. Is something started (a process, timer, connection, temp file) not stopped on every path, cancel and error included?
10. Would a changed test still pass if the behavior it names broke?
11. Did the change make a name, message, doc line or schema description untrue for a caller?

## Priority, by example

The bar is the impact if it ships. P0 only for a failure that needs no assumption about the input.

- P0: a removed null guard throws on every request without an optional header.
- P0: a new handler deletes a record by id without the auth check its neighbours make.
- P0: a loop bound `<=` reads past the end on every call.
- P0: an API key is logged whole at startup.
- P1: a retry after a failed commit books the same charge twice.
- P1: a field read before an `await` is written back after it, losing a concurrent edit.
- P1: a function now returns null for an empty list and one caller still indexes the result.
- P1: a test asserts on the mock it set up, so it passes when the code breaks.
- P2: a cache keeps entries for closed sessions until the process exits.
- P2: the docs say the timeout is 30 s, the code uses 10 s; a caller tuning by the docs times out early.
- Not a finding: a renamed local, a missing docstring, "consider adding a test", a more specific exception type.

An exploit claimed without a concrete path is rated as the weakness it rests on, not as the exploit.

## Never flag without the evidence named

- Missing, undefined, unused or not imported: only after a read or `search_code` shows it. If you searched and found
  nothing, write "searched for X, not found". Code that ends at a hunk edge is not incomplete.
- A break elsewhere ("callers may break"): only naming the caller, read, at its `path:line`.
- An assumption about the codebase or the author's intent: only when a line states it.
- Code this change didn't write: only when the change now triggers it (then pre-existing).
- Behavior a comment, lint-ignore, test or changelog entry marks as deliberate: never.
- Formatting, lint and type errors, naming, style, docstrings, comments, type hints, package versions, generated files,
  lockfiles, vendored code: never.
- Missing validation, error handling or hardening: only with an input in this code that reaches it and fails.
- Resource exhaustion and rate limits: only when the repo's rules ask.

## Limits

- P2: at most 4 on a full review, 2 on a push. Pre-existing: at most 3. At most 10 findings in all.
- Docs findings: at most 1, only when the docs now mislead a caller. Findings are advice; never block a merge.

## Commands

- `@<bot> review` or `/review`: a full re-review. `@<bot> <question>` or `/ask <question>`: an answer in the thread.
- Only people with write access trigger the bot (checked with the code host), and bots never can.

## Starter: your repository's CODEREVIEW.md

Put it at the root or under `docs/`, under 6 KB (the reviewer reads every line on every review), with these sections:
what the repo is (2-3 lines); house rules (one per line, optionally `glob: rule`); the checklist questions your code
needs beyond the eleven above; priority examples in your terms (your P0 paths: money, auth, data, secrets); never-flag
classes your team declines, with the reason; hot spots (`path`: the invariant that broke before); limits, if they
differ; and the path of a repo-knowledge skill (`.agents/skills/code-review-knowledge/SKILL.md`, sections by path glob).
