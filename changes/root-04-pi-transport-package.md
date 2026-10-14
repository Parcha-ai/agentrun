---
packages: repo
kind: feature
---
New package, `@parcha/pi-transport`: run a pi-durable session's tools in another machine. This release is its first layer: the `Box` and `BoxProvider` interfaces (create, attach, list, exec with streamed output and input, upload, download, status, destroy, an optional snapshot with a declared kind, coded `BoxError`s returned as values), `localBoxes` (`./box/local`) and `dockerBoxes` (`./box/docker`), the strict `transport` config (`parseTransportConfig`: unknown keys fail with their path, every reference names a declared environment), and a box conformance suite in `./testing` (`registerBoxConformance`, 19 cases).
- Every box has a required maximum lifetime that its provider enforces with no call from the host, a program in a box never receives the host process's environment, and a provider refuses a spec field it cannot honour. The first two are conformance cases; the lifetime case observes the machine, not the provider.
- It does not depend on the other packages. Publishing it is on hold: its manifest is `"private": true`, so it is built, tested, verified and kept at the workspace version but is in no release (see `docs/releasing.md`). Its README and `packages/pi-transport/CHANGELOG.md` have the details.
- It depends on `typebox`; pi-durable and chord (1.0.4 to 1.1.x) are peers. It follows pi's own code style and tooling inside the package: Biome, and Vitest on source through a `source` export condition. Both are development dependencies of this package only.
- CI gains two jobs: `pi-transport-pi-floor` runs its build, type-check and suite again on pi-durable 1.0.4, and `transport-docker` runs the box conformance suite on real containers.
