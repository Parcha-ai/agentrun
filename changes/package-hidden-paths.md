---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
A hidden file or folder is no part of a package anywhere in it, and nothing reads or keeps one.
- A package whose `output.schema` names a hidden file (`.answer.json`, `evals/.cache/answer.json`) is refused, and the error names it. `agentrun template validate`, an import and an apply refuse it alike. Before, the reader took it, and `agentrun deploy` sent it as the answer's schema.
- An upload (`POST /v2/templates/import`) leaves out every hidden path before it is stored: a `.env` at the top or in a skill folder is neither kept nor read back. The upload's `sha` is the package's, its files without the hidden ones. Before, a hidden file at the top of an upload was stored with it.
- `agentrun deploy DIR` names each hidden path it leaves out before it sends anything (`Left out, hidden: .env, skills/check/.DS_Store`), a hidden folder once, never what it holds. Its own `.agentrun/` is not named.
