---
packages: @parcha/agentrun-serve
kind: fix
---
A Composio trigger's config seals more addresses, and a `PATCH` no longer undoes a seal made while it ran.
- An address in any scheme with an `@` after `scheme://` and before any whitespace is sealed whole, so a password holding a raw `/`, `?` or `#` (`mongodb://u:pa/ss@host`) is caught too. An `@` in a path or query is sealed as well.
- A `PATCH` that carries a `source` writes it only on the trigger as it read it. If another write changed the trigger meanwhile (the after-start seal, or a poll's next time), the `PATCH` is checked again on the trigger as it is then, up to three times, then answers `412 precondition_failed`. The check compares the trigger's source as well as its time, so two writes in the same millisecond can't pass for one; the after-start seal's own write is checked the same way. One read before a seal is refused rather than writing the value back in the clear.
- Deleting a trigger masks every config field of the create answers kept for it under an `Idempotency-Key`, and saves them at once. A start masks those of a trigger already gone the same way before it serves, so no replay hands back a value no trigger is left to seal.
