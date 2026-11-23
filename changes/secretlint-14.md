---
packages: @parcha/agentrun-serve
kind: fix
---
`npx @parcha/agentrun` no longer opens with `npm warn deprecated @secretlint/secretlint-rule-preset-recommend`: serve's import key scan takes secretlint 14.1.0, whose core holds the recommended rules (`@secretlint/core/builtin`, the same 28 rules in the same order), and no longer depends on the deprecated preset package. One `npm warn deprecated node-domexception` remains; it comes from the Browserbase SDK and Google's auth library, whose latest releases still depend on it.
