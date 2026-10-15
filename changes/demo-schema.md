---
packages: repo
kind: feature
---
**A JSON Schema for a demo's `demo.json`**
- `examples/demo-spec.schema.json` is generated from the `DemoSpec` type of `@parcha/agentrun-pi/signin` by
  `node scripts/generate-demo-schema.mjs`; a test fails when regenerating does not give the committed file, so the type
  and the schema never drift.
- `examples/demo.schema.json` extends it with the demo template's own fields (`title`, `claim`, `targets`, `kill` and
  `kills`, `panels` as the viewer's panel ids, `tools`, `input`, `sources`, `boxes`), lists every field so a misspelt
  one is refused, and allows `targets` `hosted` only when every tool has a hosted source.
- `scripts/demo-schema.test.mjs` (`npm run test:release`) validates every `examples/*/demo.json` against it.
