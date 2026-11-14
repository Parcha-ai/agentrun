---
packages: @parcha/agentrun-computer
kind: breaking
---
A computer's daemon must match its provider exactly: the same protocol version and the same daemon version, older or newer refused alike, because the package ships the daemon with the provider. `spec/computer/README.md` now says so and why, and drops its minor/major paragraph. `npm run build:daemon` now records the daemon source it built from in `dist/computerd.json`, which the package ships beside `computerd-linux-amd64` and `-arm64`; without Go it takes both binaries from the same version on npm, when that version was built from the same daemon source. The tests that listed every provider by hand now read them from the descriptors, so a new provider edits none of them. Breaking: a daemon whose `hello` names no `protocol` is refused, where before only its version was checked.
