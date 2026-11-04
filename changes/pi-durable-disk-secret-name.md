---
packages: @parcha/pi-durable-disk
kind: feature
---
The rule for a secret's name is exported on its own, `@parcha/pi-durable-disk/secret-name` (`keyShaped`, `SECRET_SEGMENTS`, `SECRET_NAME_RULE`), and agentrun-serve takes it for every cut it makes. It now also counts a `PASS`, `PAT` or `DSN` segment, or a last `PWD` segment after another (`DB_PWD`; never `PWD` or `OLDPWD`), as a secret's, with `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` and `CREDENTIALS`: a start window's hook that returns `DB_PASS`, `GH_PAT`, `SENTRY_DSN` or `DB_PWD` fails the start `INVALID_ARGUMENT`, naming the variable, where it was added to the instance's environment.
