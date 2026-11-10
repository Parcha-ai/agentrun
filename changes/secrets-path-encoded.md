---
packages: @parcha/agentrun-serve
kind: fix
---
A held secret is cut wherever a path tool's error names it: with its "." segments dropped (`a/./b` as `a/b`), as its "//" collapsed already was, and percent-encoded as a URL's path writes it, each cut in place, the error's own words kept. Before, a secret holding "/./" written with that segment dropped was not found at all, and a percent-encoded one was found but cut the whole text. Upgrading: nothing to do.
