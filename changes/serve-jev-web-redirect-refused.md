---
packages: @parcha/agentrun-serve
kind: fix
---
The web tools' Jev requests no longer follow a redirect. A 307 from the TypeSafe host fails the sift or the passage pick, so the key never goes to another address, and the search or fetch answers as it does when Jev is down.
