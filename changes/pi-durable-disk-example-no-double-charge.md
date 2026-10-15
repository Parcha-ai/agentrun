---
packages: @parcha/pi-durable-disk
kind: docs
---
New example, `examples/no-double-charge/` (`node examples/no-double-charge/main.ts`): a paid call that never double-charges across a `kill -9`, with no disk and no key. A fake payment server in the example counts charges by idempotency key and holds invoice 2's charge in flight while the agent is killed. The run reopens in a second process, the cut `charge` call comes back `interrupted` and isn't sent again, and the server ends with one charge per invoice. `test/examples/no-double-charge.test.ts` runs it in CI.
