---
packages: @parcha/agentrun-serve
kind: fix
---
A saved secret is also cut where a run quotes it as a file path writes it (runs of `/` collapsed, a leading or trailing `/` dropped), in the run's Timeline, its answer and its learning checks. Before, a secret holding `//` could show in pieces when a tool's error named the path: a webhook trigger's signing key, whose base64 holds one now and then, among them. A learning note quoting a secret so is refused, as one quoting it as written is.
