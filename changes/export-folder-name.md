---
packages: @parcha/agentrun
kind: fix
---
`agentrun export AGENT --out DIR` refuses a folder not named as the package (exit 2, nothing written) and names the folder to use, `<parent>/<package name>`. A package's folder is named as the package is, which `agentrun template validate` checks, so the export used to exit 0 and write a package that validate then refused. Neither name is changed: the package keeps the agent's name, and `--out` is still the folder written.
