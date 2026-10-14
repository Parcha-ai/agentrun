---
packages: @parcha/pi-durable-disk
kind: docs
---
**An examples index and the conventions every new example follows**
- `examples/README.md` lists the examples with what each shows, what it needs, and whether CI runs it, and states how a
  new one is written: one directory and one property per example, self-contained imports, `node examples/<name>/main.ts`
  on a local directory with pi-ai's faux model (no key, no network), one closing `ok: ...` line, and a test under
  `test/examples/` that runs it on every change.
- `test/examples/conventions.test.ts` checks what code can: each example's files, its imports (read from the parse tree),
  its test and its row in the index. `test/examples/_run-example.ts` runs an example from a scratch directory as its own
  process group and reaps the group whatever ends it, and `assertExampleOk` fails a run that exited 0 while a
  process it started still held its output; the quickstart's test uses both.
