---
packages: repo
kind: fix
---
A request the run's spend cap held back reads as a pause on the run's timeline: labelled "Paused", in the warning tone, with the server's words, where it read as a red "Error". The server marks its row `paused: true` (it keeps kind `error`). It stays a pause after the cap is raised, and it no longer counts as a failure on the page. Any other error is unchanged.
