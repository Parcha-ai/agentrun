---
packages: @parcha/agentrun-dsl
kind: fix
---
`authorWorkflow` no longer evaluates a candidate's code during pre-acceptance validation. Before, when a host allowed executable candidates (`allowExecutableCandidates: true`), the structural validation of each candidate compiled and ran its `code` nodes against probe states in the host process, so an author-written candidate's code ran before the host's acceptance hook decided on it. Validation now checks a candidate's code for syntax only; the code runs only through a later run or dry run, after the host accepts the candidate. Hosts that leave executable candidates off (the default) were never affected. The documented note stands: a `code` node runs in the host process and is not a sandbox, so hosts isolate untrusted code themselves.
