---
packages: repo
kind: feature
---
**`apps/viewer`: the gallery bundles two recorded runs**
- `reference-job` and `ten-kills-seed21`: the reference example's job with scripted providers (no key, $0), once
  uncut and once killed ten times and resumed, recorded at one commit from a clean checkout. `recordings/README.md`
  says how each was recorded and what its counters show.
- A test holds every bundled recording to the format, with the blobs it names, and its manifest's cost and processes
  to the counters' fold; the source cost check (`scripts/recording/fold.test.mjs`) covers the gallery too.
- The README says what the deploy buttons publish: this replay viewer only, which never runs an agent or calls a model
  and asks for no key. A test parses both deploy configs and both buttons' URLs and fails on any variable, secret or
  binding.
- A run of one process or one kill reads "1 process", "1 kill" in the gallery and the header.
