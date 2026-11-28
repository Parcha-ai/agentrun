---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: docs
---
undici 8.14.0 (the HTTP/2 idle-timeout fix) reaches installs from npm through the packages' own ranges, not the repository's root `overrides`, which apply only to this repository's lockfile. serve asks for `undici ^8.14.0`, and the Archil and E2B SDKs ask for `^8.12.3`, so a fresh install resolves them all to 8.14.0 or later; an install that keeps an older lockfile keeps its older undici until it is refreshed. The coding-agent harness serve loads pins its own undici 8.12.3, which it runs with HTTP/2 off, so it can't hit the crash. The E2B provider's HTTP/1.1 connection stays as a second guard for E2B either way.
