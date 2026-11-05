---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow output's number that equals a held all-digit key in value is withheld as `[redacted]`, even when its text differs from the key's (a leading zero, `1e21`, a long key read lossy). Long runs of a GitHub fine-grained token's start (`github_pat_`) or of a JWT's first part are now redacted in time linear in their length; what is redacted is unchanged.
