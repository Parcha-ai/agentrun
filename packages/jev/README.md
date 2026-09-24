# @parcha/agentrun-jev

Optional [TypeSafe Jev](https://docs.typesafe.ai/) support for AgentRun DSL. Jev answers focused questions with typed values and probability distributions. The workflow decides how to use them.

Beta: `0.1.0-beta.4`. Requires Node.js 22.19 or later.

```sh
npm install @parcha/agentrun-dsl@beta @parcha/agentrun-jev@beta
export TYPESAFE_API_KEY="your-key"
```

```ts
import { createJevRunner } from '@parcha/agentrun-jev';

const runJudge = createJevRunner();
// Supply runJudge alongside your other runWorkflow dependencies.
const result = await runJudge({
  label: 'triage',
  kind: 'judge',
  state: { ticket: 'I was charged twice.' },
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: { billing: 'Invoices, payments, or refunds', other: 'Everything else' },
    },
  },
});
console.log(result.answers.team);
```

`judge`, `pick`, `sift`, `route`, semantic predicates, and judgment verification use the same `runJudge` adapter. Choice, Noul, and Score answers retain their raw probabilities. The core validates answer IDs, probability keys and normalization, score rubrics, and value ranges before consuming a result. A typed answer records the model's decision. It does not prove that a real-world claim is true.

`System One` is TypeSafe's typed-question interface, exposed by the SDK as `systemOne`. A Noul answer is a truth probability from 0 to 1; the DSL converts probabilities of at least 0.5 to `true` and retains the probability beside that value. Choice and Score confidence comes from the response. Jev does not return a separate confidence for Noul; the DSL derives its own gate-strength value from the distance from 0.5, scaled to the range 0 to 1. These numbers are useful gate inputs, not calibrated guarantees.

The public adapter API includes `createJevRunner`, `JevError`, `isJevResponseReason`, and the types `JevOptions`, `JevClient`, `JevErrorCode`, `JevResponseReason`, and `JevResponseDiagnostic`. The shared question, answer and distribution helpers live in `@parcha/agentrun-dsl`.

## Configuration

```ts
const controller = new AbortController();
const runJudge = createJevRunner({
  timeoutMs: 30_000,       // Total budget, including retry waits.
  maxAttempts: 3,         // Includes the first attempt; maximum 10.
  retryBaseMs: 500,
  retryMaxMs: 5_000,
  signal: controller.signal,
});
```

The official `@typesafe-ai/sdk` resolves `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL`. Explicit `apiKey` and `baseURL` options take precedence. An API root ends before `/v1/systemone`. Set `fetch` for a custom transport, or supply a `client` with a `systemOne(request, options)` method. A custom client must honor the request signal and disable its own retries; it owns its credentials and cannot be combined with transport options.

The adapter retries transient HTTP 408, 429, 5xx responses and connection failures with bounded exponential delays. SDK retries are disabled. Validation failures and other HTTP errors do not retry. The deadline and either the runner or per-call signal interrupt both requests and backoff. Cancellation bounds when the adapter returns; an uncooperative custom client can still continue its own work.

Request state has no local byte cap by default. Set `maxStateBytes` to a positive safe integer to reject serialized UTF-8 JSON state exceeding that host-owned limit before transport; omission or `null` disables this guard. This is a byte guard, not a token estimate. [Provider model context limits](https://docs.typesafe.ai/models.md) still apply. The adapter never truncates or splits state or questions.

The core allows up to 240 options per choice and 2–10 levels per score rubric. Adapter timeouts are positive integer milliseconds up to 2,147,483,647; retry delays may also be zero. `maxAttempts` is 1–10, with a default of 3.

`JevError` provides a stable `code`, `attempts`, and optional HTTP `status`. Errors deliberately omit raw service bodies, headers, input state, and causes. SDK logging is disabled. Custom clients and transports own their own logging. Do not expose credentials in browser code.

Optional `responseDiagnostic.reason` identifies a fixed response invariant, such
as `answer_keys`, `probability_mass`, or `token_usage`. An explicitly structured
capacity rejection can report `max_tokens_exceeded`; arbitrary provider messages
are never parsed for a reason. These details do not change validation, retry
policy, or the submitted evidence. Unknown causes remain unspecified.

Successful results retain `answers`, reported `model`, reported token `usage`, and a SHA-256 of the submitted request. `cost_usd` is `null` unless both usage and explicit `pricing: { inputUsdPerMillionTokens, outputUsdPerMillionTokens }` are available. Configured prices produce an estimate for the successful response; costs from unsuccessful or interrupted attempts are unknown.

## Offline tests

Inject a client to exercise the real adapter without a key or network request. After installing the DSL and Jev packages, save this as `offline-jev.mjs` and run `node offline-jev.mjs`:

```js
import assert from 'node:assert/strict';
import { createJevRunner } from '@parcha/agentrun-jev';

const runJudge = createJevRunner({
  maxAttempts: 1,
  client: {
    async systemOne(request, options) {
      options.signal?.throwIfAborted();
      assert.deepEqual(Object.keys(request.questions), ['answersQuestion']);
      return {
        answers: { answersQuestion: { type: 'noul', noul: 0.95 } },
      };
    },
  },
});

const result = await runJudge({
  label: 'screen-evidence',
  kind: 'judge',
  state: {
    question: 'Can emergency documentation fixes bypass prior approval?',
    passage: 'During an incident, the on-call engineer may merge a fix immediately; a second person reviews it the next working day.',
  },
  questions: {
    answersQuestion: {
      type: 'noul',
      instructions: 'Does the passage contain a specific rule or exception answering the question? Retain conditional and contrary evidence; reject topic mentions and promotional claims.',
    },
  },
});
assert.equal(result.answers.answersQuestion.noul, 0.95);
console.log(result.answers.answersQuestion);
```

This prints `{ type: 'noul', noul: 0.95 }`. The answer is **scripted**; it does not evaluate the passage or adapt to prompt changes. Answer IDs must match the requested question IDs. Noul returns a probability, not a boolean. Reported model and token usage may be omitted; the adapter preserves missing usage/cost as unknown instead of inventing measurements.

The [standalone TypeScript starter](https://github.com/Parcha-ai/agentrun/tree/main/examples/starter#readme) includes npm installation, a complete search-and-screen workflow, and tests for missing evidence and the screening step alone. Its injected client answers every named question generated by `sift`.

For adapter boundary tests from the repository root, run `npm run build` and `npm test -w @parcha/agentrun-jev`. Those tests inject fake HTTP responses and do not load provider credentials or call a model.

## Use a workflow as an agent tool

The [support integration example](https://github.com/Parcha-ai/agentrun/blob/main/docs/support-quickstart.md) returns a validated answer or escalation from a callable function. Register it as a tool in your application. Your host controls the surrounding agent loop, tool permissions and delivery.

## License

Apache-2.0. See the included LICENSE and NOTICE files.
