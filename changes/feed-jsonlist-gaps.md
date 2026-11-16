---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A feed trigger reading a JSON list takes two optional pointers. `fields`, 1 to 50 JSON Pointers into an item (`["/number", "/title", "/user/login"]`), keeps only those in the payload's `item`, each at its own place, before the 16 KB cap: a GitHub pull request, which is over the cap whole, now fires without `item_truncated`. `updated`, a pointer to the item's date (`"/updated_at"`), lets an item fire again with `update: true` when that date moves on; without it a JSON list's item fires only once, as before.
- `validate-template` now refuses an eval case's `web:` fixture with no `search` (or any other shape `eval-template` refuses), in the same words.
- An eval's feed fake matches the item it delivers by the trigger's `id` pointer, not by `.id`, so a JSON list read at `/number` gets an update in place of the pull request it names, not a duplicate.
- `fields` and every feed pointer (`items`, `id`, `updated`) read and write an item's own keys only: a name such as `__proto__` or `constructor` is never reached through the prototype.
- A feed's seen set now tells a missing date from a real one: an item dated 1970-01-01 or earlier fires `update: true` when its date moves on. A cursor saved before this reads a JSON list's recorded 0 as a missing date, once.
