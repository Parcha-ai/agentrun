# Decision receipts

Every System One call passes through the same interpreter boundary, including
semantic predicates and generative-node verification drives. Its versioned receipt
identifies the workflow document, execution path, host run and attempt, question
set and input hashes, elapsed time, answer validation, and available metering.
The request hash identifies content; it is never a billing deduplication key.

`WorkflowDeps.recordDecision(receipt, request)` is an optional awaited host
storage hook. The request contains exact state and questions and belongs in
protected artifact storage. Receipts contain validated answers and metadata.
General events contain opaque receipt identity and metering. Content hashes stay
in protected storage because a deterministic digest can reveal low-entropy inputs. A host
that configures the hook must persist before resolving it; a write failure stops
the workflow before the judgment can control a subsequent action. Errors preserve
both the original decision failure and a concurrent persistence failure.

`decisionContext` supplies optional run, attempt and phase identifiers. The DSL
computes the document hash itself. Unknown usage, price and provider identifiers
remain null. Unserializable input hashes are null and the adapter still reports
its structured invalid-input failure. Node labels never imply a phase. Hosts own storage, retention,
recovery and accounting; the DSL does not introduce a billing service.

The Jev adapter records each transport attempt with an independent UUID, outcome,
elapsed time, available usage and configured pricing. Identical requests can have
different attempt IDs. Adapter retries retain failed attempts. Cancellation may
leave provider completion unknown; no token count or charge is invented.

A restored completed node performs no new semantic call and emits no new decision
receipt. Hosts recovering inside an adapter can return its original attempt
records and set `replayed: true`; accounting must count transport attempt IDs once.
This interface does not make an interrupted provider request exactly-once.

Validation uses CPU tests with recorded TypeSafe responses, real interpreter
execution and a file-backed receipt sink. Coverage includes all semantic paths,
verification retries, nested execution, required persistence, cancellation,
malformed responses and recovery. These tests establish execution and accounting
contracts, not live model accuracy or task-level correctness.
