---
packages: @parcha/agentrun-dsl, @parcha/agentrun-pi
kind: breaking
---
Under the recovery driver, a value an effect adapter returns is the effect's result, whatever its fields. The driver used to read four returned fields as "outcome unknown" (`outcome`, `effect_status`, `details.outcome` or `details.effect_status` equal to `"unknown"`) and stop the run. A tool whose ordinary result had such a field, an inconclusive classifier for example, stopped every run under recovery.

An adapter that cannot know whether the outside call happened now throws a `RecoveryError` with code `FROZEN_EFFECT_UNKNOWN`, with what it observed as its `cause`. The driver keeps that cause in the checkpoint's `unknownResponses` for the operator. The effect stays unknown and is never dispatched again until the host reconciles it. An `EffectOutcomeUnknownError` works the same way, as any thrown call does.

Who breaks: a host whose `runEffect` returned one of those fields to mean "unknown". It now throws instead:

    throw new RecoveryError(message, "FROZEN_EFFECT_UNKNOWN", { cause: observed })

pi does this at its own boundary: a call that `reuseReceipts` refused (`details.effect_status` `"unknown"`) is turned into that throw by `effectResultOf`, exported from `@parcha/agentrun-pi/durable`. The extension's workflow calls use it.
