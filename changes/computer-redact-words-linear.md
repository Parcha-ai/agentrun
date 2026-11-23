---
packages: @parcha/agentrun-computer
kind: fix
---
`redactWords` reads a URL, a login, a secret-named parameter and an endpoint with a DNS name in one pass each, so a long run of word characters in an adb, phoned or pm message no longer holds the event loop. Before, each of these shapes was tried from every character of the run and read to its end, so a 40,000-character run took seconds. A JWT now starts only at the first `eyJ` of its run, for the same reason.
It cuts what it cut before, and one thing more: a JWT glued to a letter, digit or underscore before it (`x9eyJ…`, `id_eyJ…`) is now cut from its first `eyJ`. Before, it was missed, or cut only from a later `eyJ` with its first part shown. Since this shape asks only for `eyJ`, one more character and a dot, a word that holds `eyJ` before a dot is cut from there too (`heyJude.mp3` becomes `h[a secret]`).
