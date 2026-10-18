---
packages: @parcha/agentrun-serve
kind: fix
---
A half-written JSON file can no longer crash agentrun-serve. Reading a run's `run.json` or a `serve.json` caught a failed read but not a parse error, so a half-written file threw out of the adoption timer as an unhandled rejection, which ends a Node process by default. A file that is not whole JSON now reads as no file. An adopted run whose record cannot be read while its process lives is read again at the next tick, up to ten times (5 s), before it is settled, and the server says so. The server writes its own `serve.json` files whole, through a temporary file and a rename.
