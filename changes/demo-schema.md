---
packages: repo
kind: feature
---
**A JSON Schema for a demo's `demo.json`**
- `examples/demo-spec.schema.json` is generated from the `DemoSpec` type of `@parcha/agentrun-pi/signin` by
  `node scripts/generate-demo-schema.mjs`; a test fails when regenerating does not give the committed file, so the type
  and the schema never drift.
- `examples/demo.schema.json` extends it with the demo template's own fields (`title`, `claim`, `targets`, `kill` and
  `kills`, a crossing kill's `where` a non-empty object of strings, numbers and booleans and a storm's never, `panels` as the viewer's panel ids, `tools`, `input` with its `fixtures`, a map from a capture's name to its
  fixture under the demo's `fixtures/`, `sources` (`true`, or a path to a `sources.json`), `browser`, `codeMode`,
  `sites`, a parking kill's `hold` and `waitMs`, `boxes`), lists every field so a misspelt one is refused, and allows
  `targets` `hosted` only when every tool has a hosted source.
- `scripts/demo-schema.test.mjs` (`npm run test:release`) validates every `examples/*/demo.json` against it, and fails
  when the reference entry's own `DemoSpec` type (`examples/reference/demo-spec.ts`) reads a field the schema does not
  list, or allows other values for a kill's or a box's `kind` or a kill's `target`.
