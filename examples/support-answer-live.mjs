import { EffectOutcomeUnknownError, runWorkflow, workflowSha256 } from '../packages/dsl/dist/index.js';
import { createJevRunner, JevError } from '../packages/jev/dist/index.js';
import { workflow } from './support-answer.mjs';

const keySetup = 'Set TYPESAFE_API_KEY in the server process, or supply jev.apiKey from your secret loader. Get a Jev key at https://console.typesafe.ai/keys; setup: https://docs.typesafe.ai/introduction/quickstart. An agent CLI login does not supply a Jev key.';
export class SupportSetupError extends Error {}
export class SupportRunError extends Error {
  constructor(report, cause) {
    // The host needs the original error and effect settlement for reconciliation.
    // Error.cause is nonenumerable; only the redacted report is serialized.
    super('The workflow failed; see the redacted run report.', { cause });
    this.report = report;
  }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function allowedKeys(value, allowed, description) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new SupportSetupError(`${description} contains unsupported fields. Follow support-answer-config.example.mjs; live Jev cannot be replaced by a configured judge, client, or fetch.`);
  }
}
export function validateHostConfig(config, env = process.env) {
  allowedKeys(config, ['runNode', 'runEffect', 'timeoutMs', 'jev'], 'Host config');
  if (typeof config.runNode !== 'function' || typeof config.runEffect !== 'function') {
    throw new SupportSetupError('Host config must export both runNode and runEffect functions. The runtime checks all branches, including the optional agent branch.');
  }
  const jev = config.jev ?? {};
  allowedKeys(jev, ['apiKey', 'baseURL', 'model', 'timeoutMs', 'maxAttempts'], 'Jev config');
  const apiKey = jev.apiKey ?? env.TYPESAFE_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim() || /^(your[-_ ]?(jev[-_ ]?)?key|your[-_ ]?api[-_ ]?key|changeme|placeholder|<.*>)$/i.test(apiKey.trim())) {
    throw new SupportSetupError(keySetup);
  }
  const timeoutMs = config.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new SupportSetupError('timeoutMs must be a positive integer no greater than 2147483647.');
  }
  return { ...config, timeoutMs, jev: { ...jev, apiKey } };
}

// Bound model adapters that forget cancellation. The core owns effect cutoffs.
function cancellable(action, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('Workflow cancelled.', 'AbortError')); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    Promise.resolve().then(() => {
      if (signal?.aborted) throw new DOMException('Workflow cancelled.', 'AbortError');
      return action();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
const safeMetadata = result => ({
  model: typeof result.model === 'string' && /^[a-zA-Z0-9._:/-]{1,100}$/.test(result.model) ? result.model : null,
  usage: result.usage && ['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(result.usage[k]) && result.usage[k] >= 0)
    ? { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens } : null,
  request_sha256: /^[a-f0-9]{64}$/.test(result.request_sha256 ?? '') ? result.request_sha256 : null,
});
function safeFailure(error, signal) {
  if (error instanceof EffectOutcomeUnknownError) return {
    code: 'effect_outcome_unknown',
    message: 'A tool was still pending when the run stopped. Reconcile the original error cause and its settlement before retrying; cancellation does not undo the tool call.',
  };
  if (signal?.aborted || error?.name === 'AbortError') return { code: 'cancelled_or_timeout', message: 'The run was cancelled or reached its configured deadline.' };
  if (error instanceof JevError) return {
    code: `jev_${error.code}`, attempts: error.attempts,
    ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}),
    message: error.status === 401 || error.status === 403 ? keySetup : 'Jev did not complete successfully. Check provider access and server configuration; no scripted fallback was used.',
  };
  return { code: 'workflow_or_adapter_failure', message: 'Workflow validation or a host adapter failed. Inspect the host diagnostics; provider bodies and application data are omitted here.' };
}

// Lower-level execution seam for tests/custom hosts. It makes no claim that supplied adapters are live.
export async function runSupportWithAdapters(input, adapters, { signal, mode = 'caller-supplied adapters' } = {}) {
  const calls = [], events = [];
  const observe = (kind, fn) => async params => {
    const entry = { kind, label: params.label ?? params.node?.label, status: 'started' };
    calls.push(entry);
    try {
      // Forward the entire request: do not drop review, schema, tools, or cancellation.
      // Preserve the actual tool promise so core cutoff errors retain its eventual
      // receipt or rejection instead of the result of a second cancellation race.
      const value = kind === 'tool' ? await fn(params)
        : await cancellable(() => fn(params), params.signal ?? signal);
      entry.status = 'returned';
      if (kind === 'judge') Object.assign(entry, safeMetadata(value));
      return value;
    } catch (error) { entry.status = 'failed'; throw error; }
  };
  const base = () => ({
    mode, workflow_sha256: workflowSha256(workflow), calls,
    agentCalls: calls.filter(call => call.kind === 'agent').length,
    judgeCalls: calls.filter(call => call.kind === 'judge').length,
    events,
  });
  try {
    const result = await runWorkflow(workflow, input, {
      runNode: observe('agent', adapters.runNode),
      runEffect: observe('tool', adapters.runEffect),
      runJudge: observe('judge', adapters.runJudge), signal,
      onEvent: event => {
        // Retain control-flow evidence, not prompts, customer state, or raw adapter errors.
        events.push({ type: event.type, label: event.label });
        if (event.type === 'judge.answered') {
          const call = calls.findLast(call => call.kind === 'judge' && call.label === event.label);
          const answer = event.detail?.sidecar?.answers?.answersRequest;
          if (call && answer?.type === 'choice' && ['yes', 'no', 'uncertain'].includes(answer.choice)) {
            call.answer = { choice: answer.choice, confidence: answer.confidence,
              probabilities: Object.fromEntries(['yes', 'no', 'uncertain'].map(key => [key, answer.probabilities[key]])) };
          }
        }
      },
    });
    return { result, report: { ...base(), status: result.status,
      ...(result.status === 'complete' ? { output: { validated: true, sourceCount: result.output.sources.length } }
        : { escalation: { kind: result.escalation.kind, stage: result.escalation.stage } }),
    } };
  } catch (error) { throw new SupportRunError({ ...base(), status: 'failed', error: safeFailure(error, signal) }, error); }
}

export async function runLiveSupport(input, rawConfig, { signal, env = process.env } = {}) {
  const config = validateHostConfig(rawConfig, env);
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
  try {
    // No fake transport/client or replacement runJudge can enter through the live config.
    const runJudge = createJevRunner({ ...config.jev, signal: combined });
    return await runSupportWithAdapters(input, {
      runJudge, runNode: config.runNode, runEffect: config.runEffect,
    }, { signal: combined, mode: 'live Jev + configured host adapters' });
  } finally { clearTimeout(timer); }
}
