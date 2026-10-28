// Providers that each break one rule of the DecisionProvider contract, for the test that shows the conformance suite
// catches them. Run by decision-provider-mutants.test.mjs, one mutant per process, named by DECISION_MUTANT.
import { DecisionProviderError, checkCapabilities } from '@parcha/agentrun-dsl';
import { registerDecisionProviderConformance } from '@parcha/agentrun-dsl/testing';

const KEY = 'canary-key-0123456789';
const capabilities = { types: ['noul', 'choice', 'score'], inputs: ['text', 'json'], evidence: 'citations', probability: 'model', grounding: false, replay: 'never', maxQuestions: 3, maxStateBytes: 4096 };
const fail = (code, message, status) => new DecisionProviderError(code, message, { status });
const statusCode = (status) => (status === 401 || status === 403 ? 'auth' : status === 422 ? 'invalid_request' : status === 429 ? 'rate_limited' : 'http');

/** A provider over a scripted transport that keeps every rule; `breaks` replaces the parts a mutant breaks. */
function scripted(replies, breaks = {}) {
  let calls = 0;
  const send = async (signal, deadline) => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls++;
    if (reply.kind === 'hang') {
      await new Promise((resolve) => {
        if (!breaks.ignoresAbort) signal.addEventListener('abort', resolve, { once: true });
        if (!breaks.ignoresDeadline) setTimeout(resolve, deadline).unref();
        if (breaks.ignoresAbort && breaks.ignoresDeadline) setTimeout(resolve, 10_000).unref();
      });
      if (signal.aborted && !breaks.ignoresAbort) throw fail('aborted', 'The request was cancelled.');
      if (breaks.ignoresDeadline) return { kind: 'answer', answers: {} };
      throw fail('timeout', 'The request passed its deadline.');
    }
    return reply;
  };
  const provider = {
    id: 'scripted', needs: breaks.needsValue ? [KEY] : ['SCRIPTED_API_KEY'], capabilities,
    async decide(request, ctx) {
      if (!breaks.sendsOverCapacity) checkCapabilities(capabilities, request);
      let reply;
      for (let attempt = 1; ; attempt++) {
        reply = await send(ctx.signal, ctx.deadlineMs ?? 30_000);
        if (reply.kind === 'status' && reply.status === 429 && attempt < 3) continue;
        break;
      }
      if (reply.kind === 'status') {
        if (breaks.untypedErrors) throw new Error(`HTTP ${reply.status}`);
        throw fail(statusCode(reply.status), breaks.leaksKey ? `HTTP ${reply.status} with key ${KEY}` : `HTTP ${reply.status}`, reply.status);
      }
      if (reply.kind === 'malformed') throw breaks.malformedAsHttp ? fail('http', 'Bad body.') : fail('invalid_response', 'The response is not JSON.');
      const asked = Object.keys(request.questions);
      const answers = {};
      for (const [id, answer] of Object.entries(reply.answers)) {
        if (!breaks.extraAnswers && !asked.includes(id)) throw fail('invalid_response', `An answer to "${id}", which was not asked.`);
        answers[id] = breaks.refusalAsFalse && answer.type === 'refusal' ? { type: 'noul', noul: 0 } : answer;
      }
      if (!breaks.extraAnswers && asked.some((id) => !(id in answers))) throw fail('invalid_response', 'An answer is missing.');
      return {
        answers, evidence: breaks.evidenceAsText ? 'see sources' : (reply.evidence ?? []), model: 'scripted', usage: null,
        cost_usd: breaks.unknownCostAsZero ? 0 : null, cost_basis: 'unknown', provider_request_id: breaks.requestIdNumber ? 7 : 'scripted-1',
      };
    },
  };
  return { provider, calls: () => calls };
}

export const MUTANTS = {
  none: {},
  'extra-answers': { extraAnswers: true },
  'unknown-cost-as-zero': { unknownCostAsZero: true },
  'untyped-errors': { untypedErrors: true },
  'malformed-as-http': { malformedAsHttp: true },
  'ignores-abort': { ignoresAbort: true },
  'ignores-deadline': { ignoresDeadline: true },
  'leaks-key': { leaksKey: true },
  'sends-over-capacity': { sendsOverCapacity: true },
  'refusal-as-false': { refusalAsFalse: true },
  'evidence-as-text': { evidenceAsText: true },
  'request-id-number': { requestIdNumber: true },
  'needs-a-value': { needsValue: true },
};

const mutant = process.env.DECISION_MUTANT;
if (mutant) registerDecisionProviderConformance(mutant, { canary: KEY, refuses: true, build: (replies) => scripted(replies, MUTANTS[mutant]) });
