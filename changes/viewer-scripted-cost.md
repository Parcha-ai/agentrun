---
packages: repo
kind: feature
---
**`apps/viewer`: a scripted run says so**
- The cost on the counters strip names a run whose manifest says `providers: "scripted"`: "scripted, $0" rather than
  "$0.0000", or "scripted, $" and the price its fakes report, because that is not a provider's bill. A baseline's strip
  uses the baseline's own `providers`.
- The header's meta line says "scripted providers" or "real providers" when the manifest says which.
