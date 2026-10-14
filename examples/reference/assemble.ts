// The reference assembly: one job on pi-durable through the open packages, wired from a host's functions. It holds no
// job and no fake. Order: install every extension, open the run on its directory (pi resumes what a killed process
// left), reconcile the browser, start the workflow's task and wait for it, deliver, release the browser's sessions,
// close, release the run.
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, defineDoc, type ConversationId, type Harness, type Tx } from '@earendil-works/pi-durable';
import type { Workflow } from '@parcha/agentrun-dsl';
import { withRecovery, type RecoveryOptions } from '@parcha/agentrun-dsl/recovery';
import {
  createWorkflowExtension, decisionRecovery, nodeRunner, taskScope, type WorkflowOutcome,
} from '@parcha/agentrun-pi/durable';
import { ArchilCodingTools, archilEnv, openClaimDir, openDurableRun, type Claim, type RunEnv, type RunRef } from '@parcha/pi-durable-disk';
import { DEFAULT_BROWSER_POLICY } from '@parcha/pi-browser';
import { createBrowserExtension } from '@parcha/pi-browser/durable';
import { createVisionExtension, type VisionAdapterOptions } from '@parcha/pi-vision/durable';
import type { Host, RunPlace, StatusEvent } from './host.ts';

export type Job = { workflow: Workflow; input: Record<string, unknown>; files?: Record<string, Uint8Array> };
/** How the workflow's task ended, as the task reports it, with the run's generation and what it spent. */
export type RunResult = WorkflowOutcome & { generation: number; usage: Awaited<ReturnType<Harness['usage']>> };

/** The work a conversation does, which names its evidence directory for the browser and for vision alike. */
const Label = defineDoc<{ label: string }>({ kind: 'reference.label', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ label: '' }) });

/** The run's id, and the key its workflow's task and journal are kept under. */
export const RUN_KEY = 'reference';

/** A place under `root`, or a fresh one under the temp directory. Its paths are absolute: the run's tools resolve a
 *  relative one against their own working directory, not this process's. */
export async function placeAt(root?: string): Promise<RunPlace> {
  const at = resolve(root ?? await mkdtemp(join(tmpdir(), 'agentrun-reference-')));
  await mkdir(join(at, 'work'), { recursive: true });
  return { id: RUN_KEY, root: at, work: join(at, 'work'), store: join(at, 'store') };
}

/** A claim on a plain directory: nothing to mount, nothing to fence but this process's own mark. */
function localClaim(ref: RunRef, place: RunPlace): Claim {
  let fence: { cause: unknown } | undefined;
  return {
    ref, disk: ref.disk, root: place.root, work: place.work, store: place.store, reused: false, forced: false, timings: { mountMs: 0, verifyMs: 0 },
    get fenced() { return fence !== undefined; },
    markFenced(cause) { fence ??= { cause }; },
    async barrier() { if (fence) throw new Error('fenced', { cause: fence.cause }); return { ms: 0 }; },
    async release() { return { via: 'none' as const }; },
  };
}

/** The disk run's environment, with temporary directories under `work/`. */
function runEnv(claim: Claim): RunEnv {
  const base = archilEnv(claim);
  // pi-durable-disk gap, removed by the disk's #380: its createTempDir is under `<root>/tmp`, which its own confinement refuses
  // to write, and a read that runs a program (a video through ffmpeg) writes there. This example's PNG read needs none.
  const scratch = join(claim.work, '.tmp');
  return Object.assign((target: { readonly cwd?: string }) => Object.assign(base(target), {
    createTempDir: async (prefix: string | undefined) => {
      await mkdir(scratch, { recursive: true });
      return { ok: true as const, value: await mkdtemp(join(scratch, prefix ?? 'tmp-')) };
    },
  }), { id: base.id, cleanup: base.cleanup });
}

/** What a caller may change about the run. `env`: where the run's tools act. `vision`: options for pi-vision's extension, merged over
 *  the example's (a member you give replaces ours, except `onLook` and `onMiss`, which run after ours). It is called once when the
 *  extension is built, with a getter for the run's harness (undefined until the run is open). What differs per conversation is
 *  what the options themselves take: `limits`, `eyes` and `eyesModel` are given the conversation (`{ conversationId }`). */
export type RunOptions = { env?: (claim: Claim) => RunEnv; vision?: (context: { readonly harness: Harness | undefined }) => Partial<VisionAdapterOptions> };

/** `env`: where the run's tools act. Default: the claim's `work/`, through the disk package's confined environment. */
export async function run(place: RunPlace, host: Host, job: Job, options: RunOptions = {}): Promise<RunResult> {
  // The version before this kept the store at `<root>/durable`; this one keeps it where the disk package does. Opening
  // such a directory would start the run over, so it is refused before anything runs.
  const earlier = join(place.root, 'durable', 'run.sqlite');
  if (existsSync(earlier) && !existsSync(join(place.store, 'run.sqlite'))) {
    throw Object.assign(new Error(`This run's store is at ${earlier}, and this version keeps it at ${join(place.store, 'run.sqlite')}. Resume it with the version that wrote it, or start a new directory.`), { code: 'RUN_STORE_ELSEWHERE' });
  }
  const status = async (event: StatusEvent) => { try { await host.status(event); } catch { /* a status row never fails the run */ } };
  let opened: Harness | undefined;
  const labelOf = async (id: ConversationId | undefined) => (opened && id !== undefined && (await opened.snapshot(Label, id, ctx))?.label) || 'run';

  const browser = createBrowserExtension({
    provider: (target) => host.tools.browser.provider(target), driver: host.tools.browser.driver, evidence: host.evidence,
    ...(host.tools.browser.prices ? { prices: host.tools.browser.prices } : {}),
    ...(host.credentials.redact ? { redact: { values: host.credentials.redact } } : {}),
    ...(host.decisions.browser ? { decisions: host.decisions.browser } : {}),
    ...(host.tools.browser.createDeadlineMs ? { createDeadlineMs: host.tools.browser.createDeadlineMs } : {}),
    onSession: (row, change) => status({ source: 'browser', change, row }),
  });
  const visionBase: VisionAdapterOptions = {
    evidence: host.evidence,
    scope: async (conversationId, id) => ({ label: await labelOf(id), deriveDir: `.derived/${conversationId}` }),
    ...(host.credentials.childEnv ? { env: host.credentials.childEnv } : {}),
    onLook: (look) => status({ source: 'vision', look }),
    onMiss: (miss) => status({ source: 'vision', miss }),
  };
  // The caller's options go over the example's; its onLook and onMiss run after the example's own, which keep recording.
  const more = options.vision?.({ get harness() { return opened; } }) ?? {};
  const vision = createVisionExtension({
    ...visionBase, ...more,
    onLook: async (look) => { await visionBase.onLook?.(look); await more.onLook?.(look); },
    onMiss: async (miss) => { await visionBase.onMiss?.(miss); await more.onMiss?.(miss); },
  });
  const nodes = nodeRunner({
    agent: () => ({ model: host.models.lead }),
    record: () => ({ instructions: 'Cite each source by the evidence path its tool returned.' }),
    // The browser needs its configuration in the commit that creates the conversation; `init` is the one member that runs there.
    init: async (node, tx, conversationId) => {
      (await tx.doc(Label, conversationId)).label = node.label;
      Object.assign(await tx.doc(browser.docs.Config, conversationId), { label: node.label, run: place.id, policy: DEFAULT_BROWSER_POLICY });
    },
  });
  // The workflow is one pi-durable task: a process that dies leaves it pending, and the next open resumes it.
  // pi-durable-disk gap (F3): that open resumes the task before the host can reconcile the browser, so it waits here.
  let reconciled!: () => void;
  const ready = new Promise<void>((resolve) => { reconciled = resolve; });
  const flow = createWorkflowExtension({
    // A killed process's unknown calls are settled through the driver's own open (one generation per process): its `reconcile` is asked once, after
    // that open and before anything resumes. (During a cancel the same open runs with phase `abort`: nothing is settled then.)
    options: async (invocation) => (invocation.phase === 'run' && (host.tools.answered || host.tools.rerun) ? { reconcile: reconcileOf(host.tools) } : {}),
    run: async ({ key, runtime, context, driver }) => {
      runtime.signal.throwIfAborted();
      await Promise.race([ready, once(runtime.signal, 'abort').then(() => { throw runtime.signal.reason; })]);
      // Each typed question's receipt is a row in the run's store before its answer acts, and a resumed run takes an
      // answered one instead of asking again.
      const decisions = decisionRecovery({ key, runtime, context });
      const deps = withRecovery(driver, {
        runEffect: host.tools.runEffect,
        runNode: nodes.on(taskScope(runtime), context).runNode,
        runJudge: host.decisions.runJudge,
        onEvent: (event) => void status({ source: 'workflow', event }),
        recordDecision: decisions.recordDecision,
      }, { durableNodes: true });
      return { deps: { ...deps, recovery: { ...deps.recovery!, decision: decisions.decision } } };
    },
  });
  const registry = createRegistry();
  for (const extension of [ArchilCodingTools, ...host.tools.extensions, vision.extension, browser.extension, nodes.extension, flow.extension]) registry.install(extension);

  // The job's files, in `work/`: each written beside its name and renamed into place, so one a killed process left
  // under its name is whole, and is kept.
  for (const [name, bytes] of Object.entries(job.files ?? {})) {
    const at = join(place.work, name);
    if (existsSync(at)) continue;
    await mkdir(dirname(at), { recursive: true });
    await writeFile(`${at}.${process.pid}.partial`, bytes);
    await rename(`${at}.${process.pid}.partial`, at);
  }
  const durable = await openDurableRun({ disk: 'local', region: 'local', id: place.id }, {
    mountToken: 'unused', acquire: async ({ ref }) => localClaim(ref, place), claimDir: (root) => openClaimDir(root, { fstype: null }),
    harness: { registry, models: host.models.catalog }, env: options.env ?? runEnv,
    // The recorder attaches between the open and the resume: it snapshots every document at the head the hook gives, then follows each commit.
    ...(host.record?.attach ? { beforeResume: async ({ harness, storage, head, context, generation }) => { host.record!.generation(generation); await host.record!.attach!({ session: harness, storage, head, context, gen: generation }); } } : {}),
  });
  const harness = durable.harness;
  opened = harness;
  try {
    await status({ source: 'browser', reconciled: await browser.reconcile(harness, () => true, ctx) });
    // start() refuses a request that is not the run's own, with the driver's binding mismatch, and the job reports it as a
    // refusal. The saved task stays held until start() accepts the request, so a refused job never lets it run with this host.
    let task: Awaited<ReturnType<typeof flow.start>>;
    try { task = await flow.start(harness, { key: place.id, workflow: job.workflow, input: job.input }, ctx); } catch (error) {
      const refusal = error as { code?: string; message?: string; moved?: unknown };
      if (refusal?.code !== 'RUN_STORE_BINDING_MISMATCH') throw error;
      return { status: 'refused', code: refusal.code, message: String(refusal.message), detail: { moved: refusal.moved ?? null }, generation: durable.generation, usage: await harness.usage(ctx) } as RunResult;
    }
    reconciled();
    const outcome = await task.wait(ctx);
    if (outcome.status === 'complete') await host.deliver({ record: outcome.output });
    return { ...outcome, generation: durable.generation, usage: await harness.usage(ctx) };
  } finally {
    // pi has no conversation-end event: every session still open is released here, before the close.
    const open = Object.values((await harness.snapshot(browser.docs.Inventory, ctx))?.rows ?? {}).filter((row) => row.state !== 'releasing');
    for (const conversationId of new Set(open.map((row) => row.conversationId))) {
      const conversation = await harness.conversation(conversationId as ConversationId, ctx);
      if (conversation) await browser.release(conversation, 'close', ctx);
    }
    // pi-browser gap: release returns before its background task runs, and waitForIdle does not wait for background tasks.
    for (const task of (await harness.inspect(ctx)).tasks) {
      if (task.record.kind === `${browser.extension.name}.release`) await harness.waitForTask(task.record.id, ctx);
    }
    await browser.close();
    await durable.release();
  }
}

/** The driver's `reconcile` over the host's door: each call a killed process left unknown is completed with what the door answered it, or, when the host
 *  can run it again safely, with `rerun`'s answer. A call the door never answered stays unknown, and so does one whose `argsHash` another effect
 *  shares (a retried call): its answer could be the other's. The calls the host made or found applied while settling go to the driver in `receipt.calls`,
 *  which keeps them on the effect before it completes. */
export function reconcileOf(tools: Pick<Host['tools'], 'answered' | 'rerun'>): NonNullable<RecoveryOptions['reconcile']> {
  return async (unknown, complete) => {
    const reported = new Map<string, unknown[]>();
    const journal: SettleJournal = {
      effects: () => unknown.map((effect) => ({ id: effect.id, status: 'unknown', argsHash: effect.argsHash, ...(effect.intent ? { intent: { tool: effect.intent.tool } } : {}), calls: effect.calls ?? [] })),
      // `settleEffects` hands over the whole list of calls; the driver appends only the new ones, after those an earlier process kept.
      called: async (id, calls) => { reported.set(id, calls.slice(unknown.find((effect) => effect.id === id)?.calls?.length ?? 0)); },
      complete: async (id, completion) => complete(id, completion.value, { intent: completion.intent, ...(reported.get(id)?.length ? { calls: reported.get(id) } : {}) }),
    };
    await settleEffects(journal, tools);
  };
}

/** What `settleEffects` needs of a journal: the effects admitted so far, an effect's calls, and two writes. */
export type SettleJournal = {
  effects(): Array<{ id: string; status: string; argsHash: string; intent?: { tool: string }; calls?: unknown[] }>;
  called(id: string, calls: unknown[]): Promise<unknown>;
  complete(id: string, completion: { value: unknown; files: Record<string, never>; intent: { tool: string; args: unknown } }): Promise<unknown>;
};

/** Completes each effect a killed process left unknown that the host can answer (a kept answer, or `rerun`), and reports the applied
 *  call it found, once. */
export async function settleEffects(journal: SettleJournal, { answered, rerun }: Pick<Host['tools'], 'answered' | 'rerun'>) {
  const effects = journal.effects();
  for (const effect of effects) {
    const alone = effects.filter((other) => other.argsHash === effect.argsHash).length === 1;
    const kept = effect.status === 'unknown' && effect.intent && alone && answered ? await answered(effect.argsHash) : undefined;
    // Nothing kept: the host may run it again, when that is safe, by the effect's id (not its hash, which a retry shares).
    const rerunAnswer = kept === undefined && effect.status === 'unknown' && effect.intent && rerun ? await rerun({ id: effect.id, intent: { tool: effect.intent.tool, argsHash: effect.argsHash } }) : undefined;
    const answer = kept ?? rerunAnswer;
    // A host lists every applied call exactly once. Settling from evidence (the kept answer, or a call the source answered again) finds
    // the call applied: when the effect's calls hold no applied entry the settle reports one now, and when one is listed it adds none.
    if (answer) {
      // The journal does not show an effect's calls (`effects()` omits them) and `called` replaces the list, so the calls the host kept
      // with its answer are the base; a rerun's answer carries none.
      const listed = appliedOnce(kept?.calls ?? (effect as { calls?: unknown[] }).calls ?? [], { outcome: 'applied', tool: effect.intent!.tool, argsHash: effect.argsHash, via: kept ? 'evidence' : 'rerun' });
      if (listed.added) await journal.called(effect.id, listed.calls);
    }
    if (answer) await journal.complete(effect.id, { value: answer.value, files: {}, intent: { tool: effect.intent!.tool, args: answer.args } });
  }
}

/** `calls` with `record` (an applied call) added, unless an applied call is already listed: a host lists each applied call exactly once. */
export function appliedOnce(calls: unknown[], record: { outcome: 'applied' } & Record<string, unknown>): { calls: unknown[]; added: boolean } {
  if (calls.some((call) => (call as { outcome?: unknown } | null)?.outcome === 'applied')) return { calls, added: false };
  return { calls: [...calls, record], added: true };
}

