---
packages: @parcha/agentrun-jev, @parcha/agentrun-pi
kind: fix
---
Four errors from `createJevRunner` now say what happened. A host that branches on `code` or `requestDiagnostic.reason` gets the right branch.
- A deadline that the SDK's own per-attempt timer reaches first is `timeout`, and is not retried, as when the runner's own deadline ends a call. When the SDK's timer ended the last attempt, it was `connection`: in 300 runs of a request that never answered, with one attempt, 8 to 18 came back `connection`. With attempts left, the runner's deadline ended the retry wait, so the call was `timeout` and no second request went out. A timed-out request may have been billed, and the code is what tells a host so. With `timeoutMs: null` there is no deadline: a host client's own timeout stays a connection failure and is retried.
- A `null` or missing `state` is refused before sending, as `invalid_request` with `attempts` 0 and `requestDiagnostic.reason` `invalid_state`. Before, it passed the runner's own check and the SDK refused it after the attempt began: `invalid_request` with `attempts` 1 and no diagnostic. A custom client that took a `null` state is refused it too.
- `client: null` from a JavaScript caller is no client. Before, it lifted the rule that the SDK path needs a finite `timeoutMs`, and let an image or a Box question go to OpenRouter.
- A blank per-call `model` is refused with `requestDiagnostic.reason` `unsupported_model`, the reason a model refusal already had. It was `invalid_questions`, which named the question map.
- `@parcha/agentrun-pi`'s message for an invalid Jev state no longer lists `null` as accepted.
