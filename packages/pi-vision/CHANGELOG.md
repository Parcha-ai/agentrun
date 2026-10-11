# Changelog

## Unreleased

First release of `@parcha/pi-vision`, versioned with the other packages of the repository it is published from (the release PR dates this section and gives it the workspace version).

- The package's skeleton, held from publication (`"private": true`): every entry and module its interface declares; parts not built yet throw `NotBuiltError`.
- The model contract: `read`'s media arguments and the description hosts already ship, held string for string by a snapshot test; `withReadMedia(tool)`; the `look` tool's schema and description (registered by no adapter yet); the static section; the miss codes.
- The host contract's types: `VisionOptions`, `VisionHandle`, `Eyes`, `Limits`, `EvidenceSink` and `LookRecord` (pi-browser's sink shape), `ImageProcessor` and `PreparedImage` (pi-durable's), `Provider`, `SourceProvider`, `Part`, `Plan`, `Fit`, `LookEvent`, `MissEvent`; `VisionEnv`, a structural subset of pi-durable's `ExecutionEnv` that pi-durable's environments satisfy as they are.
- Budgets: the default profile and every budget as a named constant with its source; `resolveLimits(model, host)` reads a pi-ai model's `inputLimits` and combines them with a host's route limits.
- Fragments: `#page=3`, `#page=1-37`, `#t=60,90`, `#xywh=percent:x,y,w,h`, built and parsed.
- `./testing`: fake eyes (scripted answers, a ledger, a sentinel key), a fixture directory and a PNG writer, and the provider conformance suite with a fake provider that proves it.
- It depends on `unpdf`, `@hyzyla/pdfium`, `fflate` and `@xmldom/xmldom`. `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` and `@silvia-odwyer/photon-node` are optional peers. sharp and mediabunny are passed in by a host, never a dependency or a peer, so their LGPL and MPL code stays out of the package's dependency graph.
