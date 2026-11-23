---
packages: @parcha/agentrun-computer
kind: fix
---
`redactWords` reads a URL, a login, a secret-named parameter and an endpoint with a DNS name in one pass each, so a long run of word characters in an adb, phoned or pm message no longer holds the event loop. Before, each of these shapes was tried from every character of the run and read to its end, so a 40,000-character run took seconds. It cuts exactly what it cut before.
