---
packages: @parcha/pi-browser
kind: docs
---
`@parcha/pi-browser`: the README's Quick start names the container setting (`PI_BROWSER_NO_SANDBOX=1`, or `sandbox: false`, and `--init` so a killed Chrome is reaped), documents the local Chrome's options including `sandbox`, and creates its session inside the `try`, so a failed create leaves no profile root. The entries list names `/providers/assigned` and `/recorder`, and says the core loads the two HTML packages on demand. Doc comments in the source sit on the declaration they describe, and the live view's docs name both host channels that receive the viewer URL.
