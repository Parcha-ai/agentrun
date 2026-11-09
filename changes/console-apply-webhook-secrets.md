---
packages: repo
kind: feature
---
A template's Apply screen shows each webhook trigger it made with the server's warning, in its words: the signing secret is never in an apply answer. Beside it, a link opens that trigger's page ("Open <trigger> to get its signing secret (Rotate)"), where the secret is shown. Schedule and GitHub triggers have no secret and get no link.
