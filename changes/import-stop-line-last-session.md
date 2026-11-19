---
packages: @parcha/agentrun-serve
kind: fix
---
`import` no longer says `Stopped: … run the import again for the rest` when a Ctrl+C left nothing to import. A Ctrl+C that comes while the last session is being saved finishes that session, and the summary now says `Imported N sessions into …` as an uninterrupted import does; the exit code is still 130. A Ctrl+C with sessions left (while they are listed, checked for keys, or between two of them) reads `Stopped:` as before.
