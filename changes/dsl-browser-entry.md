---
packages: @parcha/agentrun-dsl
kind: feature
---
`@parcha/agentrun-dsl/browser` and `@parcha/agentrun-dsl/browser/worker`: validate, inspect, dry-run and hash a workflow document in a browser or a Web Worker, with no `node:` import, no `Buffer` and no `eval` or `new Function` in the bundle.
`./browser` has no executor and no recovery; a `code` node runs there only through the host's `runCode`, and `serveWorker` in `./browser/worker` throws without one. The root entry is unchanged under Node: the interpreter now reaches `node:crypto`, `node:util`, typebox's compiler and the code compiler through one `#platform` seam (`imports` in `package.json`), with a browser implementation selected under the `browser` condition.
