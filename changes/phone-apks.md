---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: breaking
---
A run's phone can carry real apps: the operator names APK files on the machine that drives the phones in `PHONE_HARNESS_APKS`, a comma list of `<absolute path>@sha256:<hex>`, and each phone installs them before the agent starts on it. A file that is not there, or whose bytes are not its pin, refuses the claim in words before a phone is rented. Breaking: the phone-harness provider's `apks` option takes `{ path, sha256 }` entries, not bare paths.
- The timeline names a phone's Clock, Contacts and Files apps and the Wikipedia app by the names on their icons (it said "Deskclock" for the Clock).
