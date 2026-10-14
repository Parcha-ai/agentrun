---
packages: repo
kind: fix
---
The Lean model's `sift` no longer fails when its items exceed the question limit: like the interpreter, it refuses only a question set that cannot fit one request. The conformance corpus gains its first sift cases, a sift is scripted per item, and a case may set `limits.maxQuestionsPerRequest`.
