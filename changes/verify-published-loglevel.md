---
packages: repo
kind: fix
---
The release check's registry consumer runs `npm install` with `--loglevel=error`, so a caller that silenced npm (`npm run -s`, which sets `npm_config_loglevel=silent` for its children) still sees why the install refused. Before, the refusal still failed the check, but with an empty npm error.
