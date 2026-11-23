import { mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { NativeInstructionSnapshot } from '../native/instructions.js';
import { redactSecrets } from '../learn/secrets.js';
import { runnerSecrets } from '../runner/redact.js';
import { captureSourcePolicy, CLI_POLICY_BYTES, CLAUDE_SNAPSHOT_PENDING, CLAUDE_IMPORTS_PENDING } from './policy.js';
import { boundCaptureText, captureTranscriptCursor, collectPromptEvidence, normalizeHookInput, type CliHookInput, type DialogueMessage, type TranscriptCursor } from './evidence.js';
import { connectionScope, journalParent, journalRoot, readConnection, readPrivateJson, stateHash, writePrivateJson, type CliLearningConnection, type CliLearningRuntime } from './state.js';
import { codexHookLocation } from './codex-worktree.js';
import type { SdkUsage } from '../sdk/runs.js';
import { takeHold, releaseHold } from '../harness-install.js';

export type CliLearningHookOptions = { runtime: CliLearningRuntime; project: string; dataDir: string; url?: string };
export type CliLearningHookDependencies = {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  snapshot?: typeof captureSourcePolicy;
  /** Internal durable inbox cursor; native user input is captured before competing hooks finish. */
  cursor?: TranscriptCursor | null;
  processed?: () => Promise<void>;
  sourceRedacted?: boolean;
  sourceTruncated?: boolean;
  /** Private proof of the full terminal answer when only its bounded prefix is stored. */
  answerDigest?: string;
  /** Original durable inbox time, retained when a queued hook is replayed. */
  receivedAt?: number;
  /** A queued hook must not change enrollment between reading its receipt and replaying it. */
  connectionScope?: string;
};
type Receipt = {
  run_id: string;
  agent_id: string;
  token: string;
  learning: { enabled: boolean; revision: string | null; context: string; workflows: unknown[] };
};
type Start = { session_id: string; turn_id: string; input: string; instructions: string; policy_complete: boolean; model?: string };
type Event = { type: 'message'; role: 'user' | 'assistant'; text: string } | { type: 'tool'; id: string; name: string; status: 'started' | 'completed' | 'failed' };
type Completion = {
  status: 'completed' | 'failed' | 'cancelled'; answer: string; evidence_complete: boolean;
  seed_observed: boolean; seed_revision?: string; error?: string; model?: string; session_id: string;
  source_policy?: { instructions: string; complete: boolean };
  usage?: SdkUsage;
};
type Turn = {
  version: 1; key: string; createdAt: string; submittedAt?: number; completedAt?: number; connectionId: string; start: Start; cursor: TranscriptCursor | null;
  prior: DialogueMessage[]; priorTruncated?: boolean; priorUnordered?: boolean; priorWithheld?: boolean; sourceRedacted?: boolean; sourceTruncated?: boolean; policyRecoveryAllowed?: boolean; sourceStanding?: NativeInstructionSnapshot; dialogue?: DialogueMessage[]; receipt?: Receipt; context?: string; seedMarker?: string;
  events?: Event[]; completion?: Completion; sentBatches?: number; delivered?: boolean; failure?: string;
};
type Session = { active: string[]; history: DialogueMessage[]; historyThrough?: number; historyUnordered?: boolean; historyTruncated?: boolean; historyWithheld?: boolean; completed: string[]; retryAfter?: string };
type PendingHook = { version: 1; createdAt: number; input: Record<string, unknown>; cursor?: TranscriptCursor | null; redacted?: boolean; truncated?: boolean; answerDigest?: string };
type RetryCursor = { pendingAfter?: string; sessionAfter?: string };

/** A retained receipt or busy lock never permanently occupies a bounded retry slot. Names,
 * not array offsets, keep progress stable when hooks add or remove receipts between retries. */
function retryBatch(names: string[], after?: string): string[] {
  const sorted = names.slice().sort();
  const next = typeof after === 'string' ? sorted.findIndex(name => name > after) : 0;
  const start = next < 0 ? 0 : next;
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, 100);
}

const rootOf = (options: CliLearningHookOptions, connection: CliLearningConnection) => journalRoot(options.dataDir, connection);
const changedEnrollment = () => new Error('CLI capture enrollment changed. The prior journal is preserved for review; it was not retried.');
function checkScope(connection: CliLearningConnection, expected?: string): string {
  const scope = connectionScope(connection);
  if (expected !== undefined && expected !== scope) throw changedEnrollment();
  return scope;
}
const turnFile = (directory: string, key: string) => join(directory, `${key}.json`);
const receiptTime = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/** A legacy turn's creation is an upper bound on its submit. Equal or unknown times
 * prove no order, so replay cannot invent an interruption of another prompt. */
function precedes(turn: Turn, receivedAt: number | undefined): boolean {
  const submittedAt = receiptTime(turn.submittedAt) ?? Date.parse(turn.createdAt);
  return receivedAt !== undefined && Number.isFinite(submittedAt) && submittedAt < receivedAt;
}

const safeError = (error: unknown) => error instanceof TransportError ? `AgentRun request failed (${error.status}).` : 'CLI learning capture could not reach AgentRun; its receipt is retained for retry.';
class TransportError extends Error { constructor(readonly status: number) { super(`AgentRun request failed (${status}).`); } }

/** The payload never determines a destination. Only the private, explicitly enrolled loopback connection does. */
function baseUrl(connection: CliLearningConnection): URL {
  const url = new URL(connection.url);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('CLI learning requires the enrolled local AgentRun server.');
  }
  return url;
}

async function assertActiveConnection(dataDir: string, connection: CliLearningConnection): Promise<void> {
  const current = await readConnection(dataDir, connection.runtime, connection.project);
  if (!current || current.revocation_pending) throw changedEnrollment();
  checkScope(current, connectionScope(connection));
}

async function post(dataDir: string, connection: CliLearningConnection, path: string, token: string, body: unknown, key: string, fetcher: typeof fetch): Promise<any> {
  await assertActiveConnection(dataDir, connection);
  const response = await fetcher(new URL(`/v2${path}`, baseUrl(connection)), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2000), redirect: 'error',
  });
  if (!response.ok) throw new TransportError(response.status);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function begin(dataDir: string, connection: CliLearningConnection, path: string, turn: Turn, fetcher: typeof fetch): Promise<void> {
  if (turn.receipt) return;
  const receipt: Receipt = await post(dataDir, connection, `/cli-learning/connections/${encodeURIComponent(connection.connection_id)}/runs`, connection.token, turn.start, turn.key, fetcher);
  if (!receipt?.run_id || !receipt.token || receipt.agent_id !== connection.agent_id || !receipt.learning || typeof receipt.learning.context !== 'string' || !Array.isArray(receipt.learning.workflows)) {
    throw new Error('Invalid CLI learning run receipt.');
  }
  turn.receipt = receipt;
  await writePrivateJson(path, turn);
}

async function deliver(dataDir: string, connection: CliLearningConnection, path: string, turn: Turn, fetcher: typeof fetch): Promise<void> {
  if (turn.delivered || !turn.completion || !turn.events) return;
  await begin(dataDir, connection, path, turn, fetcher);
  const receipt = turn.receipt!;
  const batches: Event[][] = [];
  let batch: Event[] = [], bytes = 0;
  for (const event of turn.events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (batch.length && (batch.length >= 100 || bytes + size > 200_000)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(event); bytes += size;
  }
  if (batch.length) batches.push(batch);
  for (let index = turn.sentBatches ?? 0; index < batches.length; index++) {
    const sequence = index + 1;
    await post(dataDir, connection, `/cli-learning/runs/${encodeURIComponent(receipt.run_id)}/events`, receipt.token, { sequence, events: batches[index] }, `${receipt.run_id}:events:${sequence}`, fetcher);
    turn.sentBatches = sequence;
    await writePrivateJson(path, turn);
  }
  await post(dataDir, connection, `/cli-learning/runs/${encodeURIComponent(receipt.run_id)}/complete`, receipt.token, turn.completion, `${receipt.run_id}:complete`, fetcher);
  turn.delivered = true;
  delete turn.failure;
  await writePrivateJson(path, turn);
}

async function locked<T>(directory: string, task: () => Promise<T>, processed?: () => Promise<void>): Promise<T | undefined> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const holdPath = join(directory, '.lock');
  // Recovery must prove the old owner is gone and still owns the lock being
  // removed. A PID-only or incomplete legacy lock stays pending for explicit
  // recovery; its age cannot authorize concurrent journal writers.
  const token = await takeHold(directory, { holdPath, timeoutMs: Infinity, recoverUnknownOwner: false });
  if (!token) return undefined;
  try { const result = await task(); await processed?.(); return result; }
  finally { await releaseHold(directory, token, { holdPath }); }
}

async function hasPendingSubmit(root: string, sessionId: string, turnId?: string, priorTo?: { turnId: string; receivedAt?: number }): Promise<boolean> {
  const directory = join(root, 'pending');
  if (turnId) {
    const path = join(directory, `${stateHash(JSON.stringify([sessionId, turnId, 'UserPromptSubmit']))}.json`);
    return Boolean(await readPrivateJson<PendingHook>(path));
  }
  const names = (await readdir(directory).catch(() => [])).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  // Read the whole pending index: a large queue of SessionEnd receipts alone
  // must not make each one defer forever. Retry dispatch remains bounded.
  for (const name of names) {
    const pending = await readPrivateJson<PendingHook>(join(directory, name));
    if (pending?.input.hook_event_name !== 'UserPromptSubmit' || pending.input.session_id !== sessionId) continue;
    if (!priorTo) return true;
    if ((pending.input.turn_id ?? pending.input.prompt_id) === priorTo.turnId) continue;
    const receivedAt = receiptTime(pending.createdAt);
    // A possibly earlier submit has not yet contributed its dialogue. Neither a
    // tied timestamp nor a legacy receipt with no time proves it was later.
    if (receivedAt === undefined || priorTo.receivedAt === undefined || receivedAt <= priorTo.receivedAt) return true;
  }
  return false;
}

const historyLimit = (history: DialogueMessage[]): { history: DialogueMessage[]; truncated: boolean } => {
  const out: DialogueMessage[] = []; let bytes = 0;
  for (const message of history.slice().reverse()) {
    bytes += Buffer.byteLength(message.text);
    if (bytes > 64 * 1024 || out.length >= 100) break;
    out.unshift(message);
  }
  return { history: out, truncated: out.length !== history.length };
};

async function inProject(runtime: CliLearningRuntime, project: string, cwd: string): Promise<boolean> {
  if (cwd !== project && !cwd.startsWith(project + sep)) return false;
  if (runtime === 'codex' && cwd !== project) {
    // Codex shares hook declarations across linked worktrees. A nested worktree must not also
    // be captured by its main checkout's handler, even though it is inside that directory.
    const [enrolled, source] = await Promise.all([codexHookLocation(project), codexHookLocation(cwd)]);
    if (enrolled.checkoutRoot && source.checkoutRoot && enrolled.checkoutRoot !== source.checkoutRoot) return false;
  }
  return true;
}

/** Fail-open hook entrypoint. It never starts/resumes the user's CLI or changes its tools, permissions or policy. */
export async function runCliLearningHook(options: CliLearningHookOptions, input: unknown, dependencies: CliLearningHookDependencies = {}): Promise<Record<string, unknown> | undefined> {
  const env = dependencies.env ?? process.env;
  if (env.AGENTRUN_CLI_LEARNING_CHILD === '1') return;
  const hook = normalizeHookInput(options.runtime, input);
  if (!hook) return;
  const project = await realpath(options.project), cwd = await realpath(hook.cwd);
  if (!await inProject(options.runtime, project, cwd)) return;
  options = { ...options, project };
  const connection = await readConnection(options.dataDir, options.runtime, project);
  if (!connection || connection.revocation_pending) return;
  baseUrl(connection);
  // A CLI may still hold its old hook command after reconnecting elsewhere. Refuse that
  // destination mismatch before saving anything that a later retry could deliver.
  if (options.url && new URL(options.url).origin !== baseUrl(connection).origin) return;
  const scope = checkScope(connection, dependencies.connectionScope);
  const secrets = runnerSecrets(env, [connection.token]);
  const redact = (text: string) => redactSecrets(text, secrets, CLI_POLICY_BYTES);
  const path = join(rootOf(options, connection), 'pending', `${stateHash(JSON.stringify([hook.sessionId, hook.turnId, hook.event]))}.json`);
  let pending = await readPrivateJson<PendingHook>(path);
  if (!pending) {
    const redacted = [hook.prompt, hook.answer, hook.model].some(value => value !== undefined && redact(value) !== value);
    const prompt = hook.prompt === undefined ? undefined : boundCaptureText(redact(hook.prompt));
    const answer = hook.answer === undefined ? undefined : boundCaptureText(redact(hook.answer));
    pending = { version: 1, createdAt: Date.now(), redacted, truncated: prompt?.truncated || answer?.truncated,
      ...(answer?.truncated && hook.answer && redact(hook.answer) === hook.answer ? { answerDigest: stateHash(hook.answer.trim()) } : {}), input: {
      hook_event_name: hook.event, session_id: hook.sessionId, cwd,
      ...(hook.turnId ? { [options.runtime === 'codex' ? 'turn_id' : 'prompt_id']: hook.turnId } : {}),
      ...(prompt ? { prompt: prompt.text } : {}),
      ...(answer ? { last_assistant_message: answer.text } : {}),
      ...(hook.transcriptPath ? { transcript_path: hook.transcriptPath } : {}),
      ...(hook.model ? { model: redact(hook.model) } : {}), stop_hook_active: hook.stopHookActive,
    }, ...(hook.event === 'UserPromptSubmit' ? { cursor: await captureTranscriptCursor(hook.transcriptPath,
      { runtime: options.runtime, sessionId: hook.sessionId, turnId: hook.turnId! }) } : {}) };
    await writePrivateJson(path, pending);
  }
  return processCliLearningHook(options, pending.input, { ...dependencies, cursor: pending.cursor, sourceRedacted: pending.redacted, sourceTruncated: pending.truncated, answerDigest: pending.answerDigest, receivedAt: pending.createdAt, connectionScope: scope, processed: () => unlink(path).catch(() => {}) });
}

async function processCliLearningHook(options: CliLearningHookOptions, input: unknown, dependencies: CliLearningHookDependencies): Promise<Record<string, unknown> | undefined> {
  const env = dependencies.env ?? process.env;
  if (env.AGENTRUN_CLI_LEARNING_CHILD === '1') return;
  const hook = normalizeHookInput(options.runtime, input);
  if (!hook) return;
  const project = await realpath(options.project);
  const cwd = await realpath(hook.cwd);
  if (!await inProject(options.runtime, project, cwd)) return;
  options = { ...options, project };
  const connection = await readConnection(options.dataDir, options.runtime, project);
  if (!connection || connection.revocation_pending) return;
  baseUrl(connection);
  checkScope(connection, dependencies.connectionScope);
  if (options.url && new URL(options.url).origin !== baseUrl(connection).origin) return;
  const fetcher = dependencies.fetch ?? fetch;
  const secrets = runnerSecrets(env, [connection.token]);
  const redact = (text: string) => redactSecrets(text, secrets, CLI_POLICY_BYTES);
  const root = rootOf(options, connection);
  const directory = join(root, stateHash(hook.sessionId));
  const receivedAt = receiptTime(dependencies.receivedAt);
  let deferred = false;
  return locked(directory, async () => {
    const sessionPath = join(directory, 'session.json');
    const session = await readPrivateJson<Session>(sessionPath) ?? { active: [], history: [], completed: [] };
    // Current evidence is persisted before any network work. Old receipts are drained by `learning retry`,
    // never allowed to consume a new prompt's hook deadline while AgentRun is unavailable.
    if (hook.event === 'SessionEnd') {
      if (await hasPendingSubmit(root, hook.sessionId)) { deferred = true; return; }
      for (const key of session.active) {
        const path = turnFile(directory, key), previous = await readPrivateJson<Turn>(path);
        if (previous && !previous.completion && precedes(previous, receivedAt)) await finish(previous, path, { ...hook, event: 'Interrupt', turnId: previous.start.turn_id }, session, false);
      }
      await writePrivateJson(sessionPath, session);
      return;
    }
    const key = stateHash(JSON.stringify([options.runtime, project, hook.sessionId, hook.turnId]));
    const path = turnFile(directory, key);
    let turn = await readPrivateJson<Turn>(path);
    if (turn && turn.connectionId === connection.connection_id && !turn.delivered && !session.active.includes(key)) {
      // A process can die between the durable turn write and its session index write.
      // Replaying the pending source event repairs that index without registering a new run.
      session.active.push(key);
      await writePrivateJson(sessionPath, session);
    }
    if (hook.event !== 'UserPromptSubmit' && !turn) {
      // Lock contention can leave the preceding submit queued but not indexed yet. An
      // unrelated pre-enrollment terminal has no queued submit and is safe to acknowledge.
      deferred = await hasPendingSubmit(root, hook.sessionId, hook.turnId);
      return;
    }
    if (hook.event === 'UserPromptSubmit') {
      if (!turn) {
        // Only a later source receipt ends a prior window lacking Stop. Replay order
        // is not source order: an older queued submit must leave newer windows open.
        for (const active of session.active) {
          const oldPath = turnFile(directory, active), previous = await readPrivateJson<Turn>(oldPath);
          if (previous && !previous.completion && precedes(previous, receivedAt)) await finish(previous, oldPath, { ...hook, event: 'Interrupt', turnId: previous.start.turn_id, answer: undefined }, session, false);
        }
        const cursor = dependencies.cursor !== undefined ? dependencies.cursor : await captureTranscriptCursor(hook.transcriptPath,
          { runtime: options.runtime, sessionId: hook.sessionId, turnId: hook.turnId! });
        const historyThrough = receiptTime(session.historyThrough);
        const priorUnordered = (session.history.length > 0 && (session.historyUnordered || historyThrough === undefined || receivedAt === undefined || historyThrough >= receivedAt))
          || await hasPendingSubmit(root, hook.sessionId, undefined, { turnId: hook.turnId!, receivedAt });
        const submittedInput = boundCaptureText(redact(hook.prompt!));
        turn = {
          version: 1, key, connectionId: connection.connection_id, createdAt: new Date().toISOString(), submittedAt: receivedAt, cursor,
          start: { session_id: hook.sessionId, turn_id: hook.turnId!, input: submittedInput.text,
            instructions: 'Source policy capture did not finish; automatic promotion is disabled.', policy_complete: false,
            ...(hook.model ? { model: redact(hook.model) } : {}) }, prior: priorUnordered ? [] : session.history, priorUnordered, priorTruncated: session.historyTruncated, priorWithheld: session.historyWithheld, sourceRedacted: dependencies.sourceRedacted, sourceTruncated: dependencies.sourceTruncated || submittedInput.truncated,
        };
        await writePrivateJson(path, turn);
        session.active.push(key);
        await writePrivateJson(sessionPath, session);
        let snapshot: NativeInstructionSnapshot & { sourceStanding?: NativeInstructionSnapshot };
        try { snapshot = await (dependencies.snapshot ?? captureSourcePolicy)({ runtime: options.runtime, project: cwd, cursor, env, redact, sessionId: hook.sessionId, cachePath: join(directory, 'policy.json') }); }
        catch { snapshot = { text: '', files: [], truncated: false, incomplete: 'The source standing policy could not be captured.' }; }
        const policyText = `${snapshot.text}${snapshot.incomplete ? `\n[Incomplete source policy: ${snapshot.incomplete}]` : ''}`;
        const instructions = redact(policyText);
        turn.sourceStanding = snapshot.sourceStanding;
        turn.policyRecoveryAllowed = !snapshot.truncated && instructions === policyText
          && (!snapshot.incomplete || snapshot.incomplete === CLAUDE_SNAPSHOT_PENDING || snapshot.incomplete === CLAUDE_IMPORTS_PENDING);
        turn.start = { session_id: hook.sessionId, turn_id: hook.turnId!, input: submittedInput.text, instructions,
            policy_complete: !snapshot.incomplete && !snapshot.truncated && instructions === policyText && Buffer.byteLength(instructions) <= CLI_POLICY_BYTES,
            ...(hook.model ? { model: redact(hook.model) } : {}) };
        if (Buffer.byteLength(turn.start.instructions) > CLI_POLICY_BYTES) turn.start.instructions = 'Source policy exceeded the capture evidence limit; policy capture is incomplete.';
        await writePrivateJson(path, turn);
      }
      if (turn.completion || turn.connectionId !== connection.connection_id) return;
      try {
        await begin(options.dataDir, connection, path, turn, fetcher);
        if (!turn.receipt!.learning.enabled) return;
        if (turn.context === undefined) {
          const learning = turn.receipt!.learning;
          const context = learning.context;
          turn.seedMarker = stateHash(`${turn.receipt!.run_id}\0${learning.revision ?? ''}\0${context}`);
          turn.context = context && Buffer.byteLength(context) <= 64 * 1024
            ? `AgentRun owner corrections for this project. Treat it as subordinate to your standing instructions and the user's current request.\n\n${context}\n\nAgentRun context receipt: ${turn.seedMarker}` : '';
          await writePrivateJson(path, turn);
        }
        if (turn.context) {
          await assertActiveConnection(options.dataDir, connection);
          return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: turn.context } };
        }
      } catch (error) { turn.failure = safeError(error); await writePrivateJson(path, turn); }
    } else if (turn && turn.connectionId === connection.connection_id) {
      await finish(turn, path, hook, session);
      await writePrivateJson(sessionPath, session);
    }

    async function finish(turn: Turn, path: string, terminal: CliHookInput, session: Session, deliverNow = true) {
      if (!turn.completion) {
        const evidence = await collectPromptEvidence({ runtime: options.runtime, cursor: turn.cursor, turnId: turn.start.turn_id, sessionId: turn.start.session_id, prompt: turn.start.input, answer: terminal.answer, answerDigest: dependencies.answerDigest, seedMarker: turn.seedMarker, redact });
        // Hook input is the source user's submitted text. Transcript user envelopes may also contain
        // other hooks' synthetic context; they are never promoted into user corrections here.
        const redactedEvidence = evidence.redacted || turn.priorWithheld || turn.sourceRedacted || dependencies.sourceRedacted || evidence.answer !== redact(evidence.answer)
          || (evidence.model !== undefined && evidence.model !== redact(evidence.model))
          || evidence.messages.some(message => message.role === 'assistant' && message.text !== redact(message.text))
          || evidence.tools.some(tool => tool.id !== redact(tool.id) || tool.name !== redact(tool.name));
        if (redactedEvidence) session.historyWithheld = true;
        let truncated = turn.sourceTruncated || dependencies.sourceTruncated || evidence.truncated;
        const capture = (text: string) => {
          const bounded = boundCaptureText(redact(text));
          truncated ||= bounded.truncated;
          return bounded.text;
        };
        const dialogue = evidence.messages.filter(message => message.role === 'assistant').map(message => ({ ...message, text: capture(message.text) }));
        const initial: DialogueMessage = { role: 'user', text: capture(turn.start.input) };
        if (!dialogue.some(message => message.role === 'user' && message.text === initial.text)) dialogue.unshift(initial);
        const answer = capture(evidence.answer);
        if (answer && !dialogue.some(message => message.role === 'assistant' && message.text === answer)) dialogue.push({ role: 'assistant', text: answer });
        turn.dialogue = dialogue;
        turn.events = [
          ...turn.prior.map(message => ({ type: 'message' as const, ...message, text: capture(message.text) })),
          ...dialogue.map(message => ({ type: 'message' as const, ...message })),
          ...evidence.tools.map(tool => ({ type: 'tool' as const, ...tool, id: redact(tool.id), name: redact(tool.name) })),
        ];
        turn.sourceTruncated ||= truncated;
        turn.completion = {
          status: terminal.event === 'Stop' ? 'completed' : terminal.event === 'StopFailure' ? 'failed' : 'cancelled',
          answer, evidence_complete: terminal.event === 'Stop' && evidence.complete && Boolean(terminal.answer) && !terminal.stopHookActive && !truncated && !turn.priorTruncated && !turn.priorUnordered && !redactedEvidence,
          seed_observed: evidence.seedObserved,
          ...(evidence.seedObserved && turn.receipt?.learning.revision ? { seed_revision: turn.receipt.learning.revision } : {}),
          ...(redactedEvidence ? { error: 'Source dialogue or tool metadata contains withheld or redacted text; automatic promotion is disabled.' } : turn.priorUnordered ? { error: 'Earlier post-enrollment dialogue order could not be verified; automatic promotion is disabled.' } : truncated ? { error: 'Source dialogue exceeded the capture limit; retained text is truncated.' } : turn.priorTruncated ? { error: 'Earlier post-enrollment dialogue exceeded the capture limit; automatic promotion is disabled for this session.' } : evidence.reason ? { error: evidence.reason } : {}),
          ...(terminal.model ?? evidence.model ? { model: redact((terminal.model ?? evidence.model)!) } : {}), session_id: turn.start.session_id,
          ...(evidence.usage ? { usage: evidence.usage } : {}),
        };
        if (options.runtime === 'claude-code') {
          // Claude renders its real system snapshot after UserPromptSubmit. Pin it at completion,
          // including inherited snapshots only when the native main chain still belongs to this prompt.
          let snapshot: NativeInstructionSnapshot;
          try { snapshot = await (dependencies.snapshot ?? captureSourcePolicy)({ runtime: options.runtime, project: cwd,
            cursor: turn.cursor?.absent ? evidence.verifiedCursor ?? null : await captureTranscriptCursor(turn.cursor?.path), env, redact, sessionId: turn.start.session_id,
            turnId: turn.start.turn_id, cachePath: join(directory, 'policy.json'), pinnedStanding: turn.sourceStanding }); }
          catch { snapshot = { text: '', files: [], truncated: false, incomplete: 'The completed source policy could not be captured.' }; }
          const instructions = redact(snapshot.text);
          turn.completion.source_policy = { instructions: Buffer.byteLength(instructions) <= CLI_POLICY_BYTES ? instructions : '',
            complete: Boolean(turn.policyRecoveryAllowed) && !snapshot.incomplete && !snapshot.truncated
              && instructions === snapshot.text && Buffer.byteLength(instructions) <= CLI_POLICY_BYTES };
        }
        turn.completedAt = receivedAt;
        await writePrivateJson(path, turn);
      }
      if (!session.completed.includes(turn.key)) {
        const submittedAt = receiptTime(turn.submittedAt), completedAt = receiptTime(turn.completedAt), historyThrough = receiptTime(session.historyThrough);
        // Keep the private history, but never serve out-of-order completions as a
        // verified sequence of prior dialogue. Legacy history has no order proof.
        session.historyUnordered ||= submittedAt === undefined || completedAt === undefined || completedAt < submittedAt
          || (session.history.length > 0 && (historyThrough === undefined || submittedAt <= historyThrough));
        if (completedAt !== undefined) session.historyThrough = Math.max(historyThrough ?? completedAt, completedAt);
        const kept = historyLimit([...session.history, ...(turn.dialogue ?? [])]);
        session.history = kept.history;
        session.historyTruncated ||= kept.truncated || turn.sourceTruncated;
        session.completed.push(turn.key);
      }
      await writePrivateJson(sessionPath, session);
      if (!deliverNow) return;
      try { await deliver(options.dataDir, connection!, path, turn, fetcher); }
      catch (error) { turn.failure = safeError(error); await writePrivateJson(path, turn); }
      if (turn.delivered) session.active = session.active.filter(key => key !== turn.key);
    }
  }, async () => { if (!deferred) await dependencies.processed?.(); });
}

/** Old or unbound receipts remain untouched. Read only their indexes to make withheld recovery observable. */
async function blockedJournals(options: CliLearningHookOptions, connection: CliLearningConnection): Promise<number> {
  const parent = journalParent(options.dataDir, options.runtime, options.project);
  const hasPending = async (root: string): Promise<boolean> => {
    const pending = await readdir(join(root, 'pending')).catch(() => []);
    if (pending.some(name => /^[a-f0-9]{64}\.json$/.test(name))) return true;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      try {
        const session = await readPrivateJson<Session>(join(root, entry.name, 'session.json'));
        if (session?.active?.length) return true;
      } catch { return true; } // An unreadable old journal needs review too; never echo its text.
    }
    return false;
  };
  let blocked = Number(await hasPending(parent)); // Before scope pinning, this was the journal itself.
  const epochs = await readdir(join(parent, 'epochs'), { withFileTypes: true }).catch(() => []);
  for (const entry of epochs) {
    if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && entry.name !== connectionScope(connection)
      && await hasPending(join(parent, 'epochs', entry.name))) blocked++;
  }
  return blocked;
}

/** Retry terminal receipts only: no native task or model call is dispatched by this source-side drain. */
export async function flushCliLearning(options: CliLearningHookOptions, dependencies: Pick<CliLearningHookDependencies, 'fetch'> = {}): Promise<{ delivered: number; pending: number; blocked_journals: number }> {
  const connection = await readConnection(options.dataDir, options.runtime, options.project);
  const counts = { delivered: 0, pending: 0, blocked_journals: 0 };
  if (!connection) return counts;
  if (connection.revocation_pending) throw new Error('Capture is disabled while server revocation is pending. Run learning disconnect when the server is available.');
  baseUrl(connection);
  const scope = connectionScope(connection);
  counts.blocked_journals = await blockedJournals(options, connection);
  const root = rootOf(options, connection);
  const cursorPath = join(root, 'retry.json');
  const cursor = await readPrivateJson<RetryCursor>(cursorPath) ?? {};
  const pendingDirectory = join(root, 'pending');
  const pending = await readdir(pendingDirectory).catch(() => []);
  const selected = retryBatch(pending.filter(name => /^[a-f0-9]{64}\.json$/.test(name)), cursor.pendingAfter);
  if (selected.length) {
    cursor.pendingAfter = selected.at(-1);
    await writePrivateJson(cursorPath, cursor);
  }
  const queued: PendingHook[] = [];
  for (const name of selected) {
    const receipt = await readPrivateJson<PendingHook>(join(pendingDirectory, name));
    if (receipt) queued.push(receipt);
  }
  queued.sort((a, b) => a.createdAt - b.createdAt || Number(b.input.hook_event_name === 'UserPromptSubmit') - Number(a.input.hook_event_name === 'UserPromptSubmit'));
  for (const receipt of queued) await runCliLearningHook(options, receipt.input, { ...dependencies, connectionScope: scope });
  const directories = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
  const sessions = retryBatch(directories.map(entry => entry.name), cursor.sessionAfter);
  if (sessions.length) {
    cursor.sessionAfter = sessions.at(-1);
    await writePrivateJson(cursorPath, cursor);
  }
  for (const name of sessions) {
    const directory = join(root, name);
    await locked(directory, async () => {
      const session = await readPrivateJson<Session>(join(directory, 'session.json'));
      if (!session) return;
      const keys = retryBatch(session.active, session.retryAfter);
      if (keys.length) {
        session.retryAfter = keys.at(-1);
        await writePrivateJson(join(directory, 'session.json'), session);
      }
      for (const key of keys) {
        const path = turnFile(directory, key), turn = await readPrivateJson<Turn>(path);
        if (!turn?.completion || turn.connectionId !== connection.connection_id) continue;
        try { await deliver(options.dataDir, connection, path, turn, dependencies.fetch ?? fetch); }
        catch (error) { turn.failure = safeError(error); await writePrivateJson(path, turn); }
        if (turn.delivered) { counts.delivered++; session.active = session.active.filter(active => active !== key); }
        // Pending status is read from the durable queue after the drain, including busy locks.
      }
      await writePrivateJson(join(directory, 'session.json'), session);
    });
  }
  const remaining = await readdir(pendingDirectory).catch(() => []);
  counts.pending = remaining.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length;
  for (const entry of directories) {
    const directory = join(root, entry.name);
    const session = await readPrivateJson<Session>(join(directory, 'session.json'));
    for (const key of session?.active ?? []) {
      const turn = await readPrivateJson<Turn>(turnFile(directory, key));
      if (turn?.completion && !turn.delivered && turn.connectionId === connection.connection_id) counts.pending++;
    }
  }
  return counts;
}
