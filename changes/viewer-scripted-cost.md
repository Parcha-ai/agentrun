---
packages: repo
kind: feature
---
**`apps/viewer`: a scripted run says so**
- The cost on the counters strip names a run whose manifest says `providers: "scripted"` (at least one priced part was a
  fake, a cassette or a script): "scripted, $0" rather than "$0.0000", or "scripted, $" and the price reported, because
  that is not a provider's bill, though it may include real charges for the other parts. A baseline's strip
  uses the baseline's own `providers`.
- The header's meta line says "scripted providers" or "real providers" when the manifest says which.
