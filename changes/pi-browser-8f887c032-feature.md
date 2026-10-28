---
packages: @parcha/pi-browser
kind: feature
---
`createPageClassifier(options)` builds `decisions.classifyPage` over a host's typed-question judge (`PageJudge`, declared here so the package imports no DSL; the DSL's `runJudge` and Jev's runner are assignable to it). It asks one request a page within the run's page budget (`pageBudget`, `PageBudget`, `PAGE_GUARD_MAX_PAGES`). It marks injection at `INJECTION_THRESHOLD` and a wall or content at `PAGE_WALL_THRESHOLD`. It never rejects: a page it cannot judge is `unjudged`, with the reason in its `guard` record. A probability outside 0 to 1 is the wrong shape. A page whose wall it cannot place keeps its injection score, and the snippet screen and `pageNotice` check that score before the wall: a page at or over the threshold is withheld or marked as an injection whatever its wall.
