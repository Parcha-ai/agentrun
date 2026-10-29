# @parcha/agentrun-decisions

Held: this package is in the repository and is built and tested with the others, but is not on npm yet.

Third-party decision models for the AgentRun DSL's decision nodes (`judge`, `pick`, `sift`, a judged `route`, `ask` and a `verify` clause). Each is a `DecisionProvider`, the seam in `@parcha/agentrun-dsl`, and runs through `judgeFromProvider`, with no agent harness. Jev's provider is `jevProvider` in `@parcha/agentrun-jev`.

## Parallel Decisions

`parallelProvider()` asks [Parallel Decisions](https://docs.parallel.ai) (`POST https://api.parallel.ai/v1/decisions`): yes/no (noul), choice and score questions about a JSON state, answered with probabilities and grounded in live web evidence.

```ts
import { judgeFromProvider, runWorkflow } from '@parcha/agentrun-dsl';
import { parallelProvider } from '@parcha/agentrun-decisions';

const result = await runWorkflow(workflow, input, { runJudge: judgeFromProvider(parallelProvider()) });
```

The key is `PARALLEL_API_KEY`, read by name when a request is made, or `apiKey`. With neither, the request fails with a `DecisionProviderError` of code `configuration` that names the variable, and nothing is sent.

What it does with Parallel's answers:

- **Types and limits.** It answers `noul`, `choice` and `score`. Before sending, it refuses as `invalid_request` anything over Parallel's documented limits: more than 100 questions, a choice outside 2 to 255 options, a score outside 2 to 10 levels, a question that renders past 5,000 characters, or a state over 96,000 bytes. A choice option with no description is described by its own name.
- **Refusals.** Parallel may decline a question (`{ "type": "refusal" }`). It stays a refusal: the DSL never decodes it to a value. The run escalates for a person (`decision_refused`), or a route takes its `unsure` branch.
- **Confidence.** A choice or score that comes back without a confidence gets one derived from its probabilities, and the decision receipt's `confidence_source` says so.
- **Evidence.** Parallel's citations apply to the whole request, not to one answer, so each is evidence with `scope: "call"`.
- **Cost.** The response carries no cost, so the answered request is booked at Parallel's list price, `PARALLEL_LIST_PRICE_USD` ($0.001 per request), with `cost_basis: "estimate"`. So is one sent whose outcome was lost (below). Its `decision_id` is the `provider_request_id`.
- **Replay.** The API takes no idempotency key, so the provider declares `replay: "never"`: a paid request is never re-sent unasked. It is sent again only when it provably never reached Parallel (no DNS answer, no connection, no TLS handshake), or on a 429 that says when to retry (`Retry-After`). A 408, a 5xx or a connection lost after sending is sent once and fails `outcome_unknown`, booked at list price as an estimate. The run then escalates the decision for a person as interrupted (`decision_interrupted`), and it is never asked again.
- **Errors.** Each one is a `DecisionProviderError`:
  - 401 and 403 are `auth`;
  - 400 and 422 are `invalid_request`, with Parallel's `ref_id` as `refId` and the body dropped;
  - a 429 is retried after its `Retry-After`, and is `rate_limited` without one or once the attempts are spent;
  - a 408, a 5xx or a connection lost after sending is `outcome_unknown`, with `costUsd` and `costBasis` on the error;
  - a request that never reached Parallel is retried with backoff, then `connection`;
  - a body that is not JSON, or answers that do not match the questions, is `invalid_response`;
  - the host's abort is `aborted`, and the deadline (`timeoutMs`, 30 s by default, or the host's shorter one) is `timeout`.

  No message carries the key, a header or a body.

## Tests

`npm test -w @parcha/agentrun-decisions` runs on a fake fetch. It registers the DSL's provider conformance suite, replays 28 responses recorded from Parallel's decision tool through the seam, and checks the request as sent, the limits and the errors. `test/parallel.live.test.mjs` makes three decisions on the paid REST path (about $0.003) and runs only with `PARALLEL_API_KEY` set; without it, it is skipped and says so.

## License

Apache-2.0
