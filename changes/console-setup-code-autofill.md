---
packages: repo
kind: fix
---
Console: a password manager no longer fills a saved login into setup's Setup code field. The field says it is a one-time code (`autocomplete="one-time-code"`), and the sign-in and setup forms carry their own hidden username field for a manager to fill, so the code a setup link brings stays the code that is sent.
