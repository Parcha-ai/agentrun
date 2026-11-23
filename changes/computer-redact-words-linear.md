---
packages: @parcha/agentrun-computer
kind: fix
---
`redactWords` reads a login and a secret-named parameter in one pass, so a long run of word characters in an adb, phoned or pm message no longer holds the event loop. Before, both shapes were tried from every character of the run and read to its end, so a 40,000-character run took seconds. It cuts exactly what it cut before.
