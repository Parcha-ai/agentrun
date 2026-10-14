---
packages: repo
kind: feature
---
`@parcha/agentrun-pi/durable` reads and writes tool results the same way on pi-durable 1.0.4 to 1.2.x, in one build; pi-durable 1.2 names a tool result's blocks `output` instead of `content` and reads a result that has only `content` as empty, with no error. The peer ranges do not move yet.
- Every tool result the package writes carries its blocks under both keys: the record tool's answers and its fatal return, and `reuseReceipts`' refusal and its answer from a receipt. `toolResult(blocks, fields)` builds such a result for a host's own tools.
- **Behaviour change:** a call through `reuseReceipts(...).wrap` whose result has its blocks only under the key the loaded pi-durable does not read now throws `ToolResultKeyError` (code `TOOL_RESULT_KEY`, with the tool's name), and no receipt is written. Before, on 1.2, the model received an empty result and the receipt stored an empty text. Results are read under the loaded version's key, so a failure envelope in a 1.2 result is no longer recorded as paid.
- A Session that fails at a storage error (pi-durable 1.2 then rejects later calls with `SessionFailed`) reaches the recovery driver as the storage's own message and code, with the `SessionFailed` as its cause, and a run's `wait()` rejects with the storage's error, as on 1.1.
