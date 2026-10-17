---
packages: repo
kind: feature
---
A `--live` run's judge and model have the crossings the fakes' have (`judge.asked <label>`, `judge.answered <label>`, `model.request turn <n>`, `model.answered turn <n>`, the same names and counting), so a kill lands before a paid question or request is sent, or after its answer and before the run keeps it, and the resume pays the judge once (a kill does not cut a request while the provider has it outstanding).
