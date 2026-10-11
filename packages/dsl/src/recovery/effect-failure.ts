// An effect's failure, typed at every boundary. Every failure carries one closed code (EFFECT_FAILURE_CODES, the
// interpreter's list, which `retry.on` names); the prose stays beside it as `message`, for the reader,
// and is never the discriminator. This module holds the class a host's effect adapters throw, and the one
// classifier that maps a thrown transport error to a code from its typed facts (the error's class, its
// HTTP status, its system code), never from its text.
import { CALL_TRANSPORTS } from "../vocabulary.js";
import { EffectFailure, type CallRetryClass, type EffectFailureCode } from "../workflow.js";
import { effectRetryClass, transportFactOf } from "./transport-facts.js";

/** The retry class a code implies when the failure's transport facts name none: a deadline is a
 *  timeout and a non-zero exit is an exit, the two the interpreter's default retry list names; every
 *  other code is not transient by nature. */
const IMPLIED_RETRY_CLASS: Partial<Record<EffectFailureCode, CallRetryClass>> = { effect_timeout: "timeout", effect_exit: "exit" };

/** A failed effect: its closed code, the prose for the reader, and what the host observed
 *  (`detail`: the deadline, the elapsed time, the output tail, the filed output) which the
 *  interpreter writes onto the attempt's `effect.failed` event. The retry class is the transport's
 *  when it gave one, else the code's. */
export class TypedEffectFailure extends EffectFailure {
  declare readonly code: EffectFailureCode;
  constructor(code: EffectFailureCode, message: string, options: { detail?: Record<string, unknown>; cause?: unknown; retryClass?: CallRetryClass | null } = {}) {
    super(message, options.retryClass !== undefined ? options.retryClass : IMPLIED_RETRY_CLASS[code] ?? null, {
      code, ...(options.detail ? { detail: options.detail } : {}), ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
  }
}

/** A dispatch that succeeded around a failed tool: the transport answered with the tool's own failure
 *  envelope as its text. The envelope is the effect's failure, never its result. */
export class EffectEnvelopeFailure extends Error {
  constructor(readonly tool: string, readonly envelope: string) {
    super(`tool "${tool}" returned a failure: ${envelope.slice(0, 500)}`);
    this.name = "EffectEnvelopeFailure";
  }
}

/** A thrown error at an effect boundary, as a TypedEffectFailure. A TypedEffectFailure passes through; a
 *  tool the host did not grant (`notGranted` names it) is effect_not_granted; an unknown transport
 *  (`via` outside the interpreter's list) is effect_unknown_transport; a tool's failure envelope is
 *  effect_transport; otherwise the error's typed transport facts decide: a deadline (a TimeoutError, an
 *  AbortError, a 408, an idle cut, a timed-out connect) is effect_timeout, any other typed fact (a
 *  status, a system code, an error class) is effect_transport with the retry class those facts earn
 *  (effectRetryClass), and an error with no typed fact came through no transport that can be named:
 *  effect_unknown_transport. The message is carried for the reader and never read. */
export function classifyEffectFailure(error: unknown, at: { label: string; via: string }, options: { notGranted?: (error: unknown) => string | undefined } = {}): TypedEffectFailure {
  if (error instanceof TypedEffectFailure) return error;
  const text = error instanceof Error ? error.message : String(error);
  const message = `call node "${at.label}": ${text.slice(0, 500)}`;
  const refused = options.notGranted?.(error);
  if (refused !== undefined) return new TypedEffectFailure("effect_not_granted", message, { cause: error, detail: { tool: refused } });
  if (!(CALL_TRANSPORTS as readonly string[]).includes(at.via)) return new TypedEffectFailure("effect_unknown_transport", message, { cause: error, detail: { transport: at.via } });
  if (error instanceof EffectEnvelopeFailure) return new TypedEffectFailure("effect_transport", message, { cause: error, retryClass: null });
  const fact = transportFactOf(error);
  const retryClass = effectRetryClass(fact);
  if (retryClass === "timeout" || fact.errorName === "AbortError") return new TypedEffectFailure("effect_timeout", message, { cause: error, retryClass });
  const typed = fact.status !== undefined || fact.causeCode !== undefined || fact.errorName !== undefined || fact.providerType !== undefined || fact.providerCode !== undefined;
  return new TypedEffectFailure(typed ? "effect_transport" : "effect_unknown_transport", message, { cause: error, retryClass });
}
