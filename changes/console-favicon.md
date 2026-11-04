---
packages: repo
kind: fix
---
The console's page declares its own icon, an orange square with a run mark, so the browser never asks for /favicon.ico and no page load logs a 404 for it.
