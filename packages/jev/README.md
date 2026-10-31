# @parcha/agentrun-jev

Optional [TypeSafe Jev](https://docs.typesafe.ai/) support for AgentRun DSL. Jev answers focused questions with typed values and probability distributions. The workflow decides how to use them.

Beta, on npm under the `beta` dist-tag (`npm view @parcha/agentrun-jev dist-tags`). Requires Node.js 22.19 or later.

```sh
npm install @parcha/agentrun-dsl@beta @parcha/agentrun-jev@beta
```

## Offline tests

To exercise the real adapter with no key and no network request, inject a client. After installing the packages, save this as `offline-jev.mjs` and run `node offline-jev.mjs`:

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

## Call Jev

A live call needs a key. Set it, then run the sample below as `live-jev.mjs` (`node live-jev.mjs`). The samples that follow are written in TypeScript; run them with a TypeScript runner such as `npx tsx`, or drop the `type` imports and annotations to run them as `.mjs`.

```sh
export TYPESAFE_API_KEY="your-key"
```

```js
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

Without a key, or with an `apiKey` that is blank, `createJevRunner()` throws `JevError` (code `configuration`: "Could not configure Jev. Supply apiKey or set TYPESAFE_API_KEY, and check transport options.") on that line, before any request is made. The same holds for `provider: "openrouter"` without `OPENROUTER_API_KEY`.

`judge`, `pick`, `sift`, `route`, semantic predicates, and judgment verification use the same `runJudge` adapter. Choice, Noul, and Score answers retain their raw probabilities. The core validates answer IDs, probability keys and normalization, score rubrics, and value ranges before consuming a result. A typed answer records the model's decision. It does not prove that a real-world claim is true.

`System One` is TypeSafe's typed-question interface, exposed by the SDK as `systemOne`. A Noul answer is a truth probability from 0 to 1; the DSL converts probabilities of at least 0.5 to `true` and retains the probability beside that value. Choice and Score confidence comes from the response. Jev does not return a separate confidence for Noul; the DSL derives its own gate-strength value from the distance from 0.5, scaled to the range 0 to 1. These numbers are useful gate inputs, not calibrated guarantees.

The public adapter API is `createJevRunner`, `jevProviderFromEnv`, `JevError`, `isJevResponseReason`, and the types `JevOptions`, `JevClient`, `JevProvider`, `JevErrorCode`, `JevResponseReason`, `JevResponseDiagnostic`, `JevRequestDiagnostic`, `JevImage`, `JevJudge`, `JevJudgeParams` and `JevJudgeResult`. The shared question, answer and distribution helpers live in `@parcha/agentrun-dsl`.

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

### Through OpenRouter

Jev is also served by OpenRouter's System One path, on the same request shape. Choose it with `provider`:

```ts
import { createJevRunner, jevProviderFromEnv } from "@parcha/agentrun-jev";

const runJudge = createJevRunner({ provider: "openrouter" });             // key: apiKey, else OPENROUTER_API_KEY
const byEnv = createJevRunner({ provider: jevProviderFromEnv(process.env) }); // OpenRouter only when only OPENROUTER_API_KEY is set
```

`provider: "openrouter"` sends to `https://openrouter.ai/api/v1/systemone` (an explicit `baseURL` wins) and defaults the model to `~typesafe/jev-latest`; pin `typesafe/jev-1.14` when a result must be reproducible. It never falls back to `TYPESAFE_API_KEY`: with no OpenRouter key it is a configuration error. The default provider is `typesafe` and nothing changes for it. `provider` cannot be combined with `client`.

Cost: when the response reports `usage.cost` (USD) it is `cost_usd`; otherwise a configured `pricing` estimate is used; otherwise `cost_usd` is `null`, never 0. A `usage` with a cost and no token counts is accepted and returns `usage: null`. Requests over about 32 KB of state run in the provider's slower long-context mode.

The official `@typesafe-ai/sdk` resolves `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL`. Explicit `apiKey` and `baseURL` options take precedence. An API root ends before `/v1/systemone`. Set `fetch` for a custom transport, or supply a `client` with a `systemOne(request, options)` method. A custom client must honor the request signal and disable its own retries; it owns its credentials and cannot be combined with transport options.

A Jev request is paid once it is sent, so the adapter never sends it again unasked. It retries, with bounded exponential delays, only a request that provably never reached Jev (no DNS answer, no connection, no TLS handshake) and a 429 with a `Retry-After` (seconds or an HTTP date). It waits the larger of that and its own delay, and gives up at once, with attempts left, when that wait would not end before the timeout. A 429 without `Retry-After` is an `http` error at once. A 408, a 5xx or a connection lost after sending is sent once and fails with code `outcome_unknown` (and the HTTP `status` when there is one): it may have been answered and billed, and its cost is unknown.

`retryAfterSend: true` restores the retries of earlier versions, which can re-send a paid request. With it, the adapter also retries a 408, any 429, a 5xx and a lost connection; on a 503 with `Retry-After` it waits as above. When the attempts end on a 429 after an earlier 408, 5xx or lost connection, the error reports the first of those failures (its HTTP `status`, or code `connection`), since that attempt may have been billed; an `http` error with status 429 means every attempt was refused. SDK retries are disabled. Validation failures and other HTTP errors do not retry. The deadline and either the runner or per-call signal interrupt both requests and backoff. A call the deadline ends is `timeout`, whether the runner's timer or the SDK's per-attempt timer fired first, and is not retried. Cancellation bounds when the adapter returns; an uncooperative custom client can still continue its own work.

Request state has no local byte cap by default. Set `maxStateBytes` to a positive safe integer to reject serialized UTF-8 JSON state exceeding that host-owned limit before transport; omission or `null` disables this guard. This is a byte guard, not a token estimate. [Provider model context limits](https://docs.typesafe.ai/models.md) still apply. The adapter never truncates or splits state or questions.

The core allows up to 240 options per choice and 2–10 levels per score rubric. Adapter timeouts are positive integer milliseconds up to 2,147,483,647; retry delays may also be zero. `maxAttempts` is 1–10, with a default of 3.

`JevError` provides a stable `code`, `attempts`, and optional HTTP `status`. A request the runner refuses before sending it has code `invalid_request`, `attempts` 0 and a `requestDiagnostic` (`JevRequestDiagnostic`): a `reason` (`invalid_state`, `state_too_large`, `invalid_questions`, `invalid_assets`, `unsupported_model` or `unsupported_provider`), the call's `label` (at most 200 characters) when it has one, and for a state over `maxStateBytes` its `stateBytes` and `maxStateBytes`. Errors deliberately omit raw service bodies, headers, input state, and causes. SDK logging is disabled. Custom clients and transports own their own logging. Do not expose credentials in browser code.

Optional `responseDiagnostic.reason` identifies a fixed response invariant, such
as `answer_keys`, `probability_mass`, or `token_usage`. An explicitly structured
capacity rejection can report `max_tokens_exceeded`; arbitrary provider messages
are never parsed for a reason. These details do not change validation, retry
policy, or the submitted evidence. Unknown causes remain unspecified.

Successful results retain `answers`, reported `model`, reported token `usage`, and a SHA-256 of the submitted request. `cost_usd` is the response's reported `usage.cost` when it has one, else an estimate from the counted tokens and an explicit `pricing: { inputUsdPerMillionTokens, outputUsdPerMillionTokens }`, else `null`. Configured prices produce an estimate for the successful response; costs from unsuccessful or interrupted attempts are unknown.

## Images and Box questions

Jev 1.13 and 1.14 read still images, and Jev 1.14 can answer a Box question: where in an image something is. TypeSafe leaves both off unless a request says it carries one, and the runner says so for you: it sends `TypeSafe-Danger-Zone-Images: true` on every request that carries an image or a Box question and on no other.

```ts
import { createJevRunner, type JevJudge } from '@parcha/agentrun-jev';

const judge: JevJudge = createJevRunner({ model: 'jev-1.14.0' });
const { answers, usage, cost_usd } = await judge({
  label: 'door', kind: 'judge',
  state: 'The camera shows <photo>.',
  questions: {
    open: { type: 'noul', instructions: 'Is the door in <photo> open?' },
    door: { type: 'box', instructions: 'the door in <photo>' },
  },
  assets: { '<photo>': { bytes: pngOrJpegFileBytes, mime: 'image/png' } },   // PNG or JPEG file bytes
});
// answers.door = { type: 'box', box: { top, bottom, left, right }, confidence } — edges are fractions of the image's height and width
```

- `assets` maps each reference, a string that appears literally in `state` or in a question's `instructions` or `criteria`, to the image. The runner builds the SDK's image from the bytes and sends it as a multipart file part. Each reference must appear inside a string value of the state, an instruction or a criterion (a question id or an option name does not count), or the request is refused.
- A Box question needs a model named for it: `model: 'jev-1.14.0'`, a later version, or `'jev-preview'`. The runner checks the name, so it refuses a Box on `jev-latest` whatever version that alias points at. A Box on any other model, or a Box with no image, is refused with `JevError` code `invalid_request` before any request. `model` can also be named per call.
- Before any request, the runner also refuses what Jev would reject: a file that is not PNG or JPEG (the bytes are checked against `mime`), an empty file, a file over 16 MiB, a reference nothing uses. It does not check pixel dimensions (each side 280 to 1568, total 78,400 to 2,458,624 pixels) or the 32 MiB request limit; Jev rejects those with a 400 or 413, which surfaces as a typed `http` error.
- Images are billed as input tokens at the text price, and `usage.input_tokens` counts them. `cost_usd` is as for text: the provider's reported cost, else your `pricing` applied to the counted tokens, else `null`. `request_sha256` names each image by its own SHA-256, so the same request hashes the same and a different image does not.
- A Box answer is always a box (there is no "not found"): ask a noul question in the same request to check presence. Edges and confidence are checked to lie in [0, 1] and the box to run forward (`top <= bottom`, `left <= right`); a confidence the provider omits is `null`.
- `JevJudge`, `JevJudgeParams`, `JevJudgeResult` and `JevImage` are the types of this call. A package that asks Jev about images takes a `JevJudge` from its host and never imports the SDK.
- Images and Box go to TypeSafe's own API only. The OpenRouter path is not verified for them, so a request that carries either is refused with `provider: "openrouter"`.
- Request bodies are sent uncompressed; the SDK's default compresses them with zstd.
- Box is a preview: Jev's page says its request format, answers and limits can change between releases.

## As a DecisionProvider

`jevProvider(options)` is Jev behind the DSL's provider seam, for a host that runs every decision model the same way. It takes `createJevRunner`'s options, and `judgeFromProvider(jevProvider())` is a `runJudge`:

```ts
import { judgeFromProvider, runWorkflow } from '@parcha/agentrun-dsl';
import { jevProvider } from '@parcha/agentrun-jev';

const result = await runWorkflow(workflow, input, { runJudge: judgeFromProvider(jevProvider()) });
```

It sends each decision once, since a paid request is never re-sent unasked: it runs `createJevRunner` with `maxAttempts: 1`, whatever `maxAttempts` you pass. A 408, a 5xx or a connection error (the SDK cannot tell one before sending from one after) is `outcome_unknown` at an unknown cost, and the run escalates the decision as interrupted. It declares noul, choice and score questions from text or JSON (a box question needs an image, which the seam does not carry yet), no evidence, and the key it reads by name (`TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` with `provider: "openrouter"`). Its other errors are `DecisionProviderError`s with Jev's message: an HTTP 401 or 403 is `auth`, a 429 `rate_limited`, and a 400 or 422 `invalid_request`. A deadline that ends the request in flight (the host's, or the runner's own `timeoutMs`) is `outcome_unknown` too, since it may have been answered; only the host's own cancel is `aborted`. A cost is booked `reported` with no `pricing` set, and `estimate` with one. It passes the conformance suite in `@parcha/agentrun-dsl/testing` (`test/decision-provider.test.mjs`).

## Testing your own host

The [standalone TypeScript starter](https://github.com/Parcha-ai/agentrun/tree/main/examples/starter#readme) includes npm installation, a complete search-and-screen workflow, and tests for missing evidence and the screening step alone. Its injected client answers every named question generated by `sift`.

For adapter boundary tests from the repository root, run `npm run build` and `npm test -w @parcha/agentrun-jev`. Those tests inject fake HTTP responses and do not load provider credentials or call a model.

## Use a workflow as an agent tool

The [support integration example](https://github.com/Parcha-ai/agentrun/blob/main/docs/support-quickstart.md) returns a validated answer or escalation from a callable function. Register it as a tool in your application. Your host controls the surrounding agent loop, tool permissions and delivery.

## License

Apache-2.0. See the included LICENSE and NOTICE files.
