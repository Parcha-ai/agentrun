---
packages: @parcha/pi-vision
kind: feature
---
A cancelled read leaves nothing behind: its temp directory, and a derivation or a document's text it was putting in place, are removed with a context of their own, since pi's environments refuse every operation once the call's signal is aborted. Every cleanup in the package follows that rule.
