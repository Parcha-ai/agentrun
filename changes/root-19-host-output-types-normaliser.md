---
packages: repo
kind: feature
---
`applyHostOutputTypes(candidate, host, { normalizeType })` takes an optional normaliser: an authored artifact type (another case, dashes for underscores, an alias) is mapped to the host's name for it before the host's prose types are matched; a type it maps to null or undefined is left as authored, an exact name included. Without it a type is matched exactly, as before. `candidatePolicyErrors` still compares a candidate's artifact types to the host's list exactly.
