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
import { createRegistry, defineDoc, type ConversationId, type Extension, type Harness } from '@earendil-works/pi-durable';
import type { Workflow } from '@parcha/agentrun-dsl';
import { bindingMismatch, canonicalHash, recoveryBinding, recoveryBound } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, documentStore, nodeRunner, taskScope, type WorkflowInvocation, type WorkflowOutcome, type WorkflowRequest } from '@parcha/agentrun-pi/durable';
import { ArchilCodingTools, archilEnv, openClaimDir, openDurableRun, type Claim, type RunEnv, type RunRef } from '@parcha/pi-durable-disk';
import { createBrowserExtension } from '@parcha/pi-browser/durable';
import { createVisionExtension } from '@parcha/pi-vision/durable';
import type { Host, RunPlace, StatusEvent } from './host.ts';

export type Job = { workflow: Workflow; input: Record<string, unknown>; files?: Record<string, Uint8Array> };
/** How the workflow's task ended, as the task reports it, with the run's generation and what it spent. */
export type RunResult = WorkflowOutcome & { generation: number; usage: Awaited<ReturnType<Harness['usage']>> };

/** The work a conversation does, which names its evidence directory for the browser and for vision alike. */
const Label = defineDoc<{ label: string }>({ kind: 'reference.label', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ label: '' }) });
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 };

/** A place under `root`, or a fresh one under the temp directory. Its paths are absolute: the run's tools resolve a
 *  relative one against their own working directory, not this process's. */
export async function placeAt(root?: string): Promise<RunPlace> {
  const at = resolve(root ?? await mkdtemp(join(tmpdir(), 'agentrun-reference-')));
  await mkdir(join(at, 'work'), { recursive: true });
  return { id: 'reference', root: at, work: join(at, 'work'), store: join(at, 'store') };
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
  // pi-durable-disk gap: its createTempDir is under `<root>/tmp`, which its own confinement refuses to write, and vision writes there.
  const scratch = join(claim.work, '.tmp');
  return Object.assign((target: { readonly cwd?: string }) => Object.assign(base(target), {
    createTempDir: async (prefix: string | undefined) => {
      await mkdir(scratch, { recursive: true });
      return { ok: true as const, value: await mkdtemp(join(scratch, prefix ?? 'tmp-')) };
    },
  }), { id: base.id, cleanup: base.cleanup });
}

/** `env`: where the run's tools act. Default: the claim's `work/`, through the disk package's confined environment. */
export async function run(place: RunPlace, host: Host, job: Job, options: { env?: (claim: Claim) => RunEnv } = {}): Promise<RunResult> {
  const status = async (event: StatusEvent) => { try { await host.status(event); } catch { /* a status row never fails the run */ } };
  let opened: Harness | undefined;
  // Vision names a conversation by its id as a string; pi's documents take the number.
  const labelOf = async (conversationId: string) => (opened && (await opened.snapshot(Label, Number(conversationId) as ConversationId, ctx))?.label) || 'run';

  const browser = createBrowserExtension({
    provider: (target) => host.tools.browser.provider(target), driver: host.tools.browser.driver, evidence: host.evidence,
    ...(host.tools.browser.prices ? { prices: host.tools.browser.prices } : {}),
    ...(host.credentials.redact ? { redact: { values: host.credentials.redact } } : {}),
    ...(host.decisions.browser ? { decisions: host.decisions.browser } : {}),
    onSession: (row, change) => status({ source: 'browser', change, row }),
  });
  const vision = createVisionExtension({
    evidence: host.evidence,
    scope: async (conversationId) => ({ label: await labelOf(conversationId), deriveDir: `.derived/${conversationId}` }),
    ...(host.credentials.childEnv ? { env: host.credentials.childEnv } : {}),
    onLook: (look) => status({ source: 'vision', look }),
    onMiss: (miss) => status({ source: 'vision', miss }),
  });
  const nodes = nodeRunner({
    agent: () => ({ model: host.models.lead }),
    record: () => ({ instructions: 'Cite each source by the evidence path its tool returned.' }),
    // The browser needs its configuration in the commit that creates the conversation; `init` is the one member that runs there.
    init: async (node, tx, conversationId) => {
      (await tx.doc(Label, conversationId)).label = node.label;
      Object.assign(await tx.doc(browser.docs.Config, conversationId), { label: node.label, run: place.id, policy: POLICY });
    },
  });
  // The workflow is one pi-durable task: a process that dies leaves it pending, and the next open resumes it.
  // pi-durable-disk gap (F3): that open resumes the task before the host can reconcile the browser, so it waits here.
  let reconciled!: () => void;
  const ready = new Promise<void>((resolve) => { reconciled = resolve; });
  const flow = createWorkflowExtension({
    options: async (invocation) => { if (host.tools.answered) await settle(invocation, host.tools.answered); return {}; },
    run: async ({ runtime, context }) => {
      runtime.signal.throwIfAborted();
      await Promise.race([ready, once(runtime.signal, 'abort').then(() => { throw runtime.signal.reason; })]);
      return {
        adapters: {
          runEffect: host.tools.runEffect,
          runNode: nodes.on(taskScope(runtime), context).runNode,
          runJudge: host.decisions.runJudge,
          onEvent: (event) => void status({ source: 'workflow', event }),
        },
        durableNodes: true,
      };
    },
  });
  // Until the browser's pi range admits 1.1.0 (#336), this process loads pi-durable 1.0.4 (here, the browser, vision) and
  // two 1.1.0 copies (the node runner and the workflow task, the disk run). The values cross them unchanged; their branded
  // types do not, so the crossings below are cast: extensions into the registry, the registry into the run, the Harness
  // out of the run and into the workflow's task, and the task's id back.
  const registry = createRegistry();
  for (const extension of [ArchilCodingTools, ...host.tools.extensions, vision.extension, browser.extension, nodes.extension, flow.extension] as Extension[]) registry.install(extension);

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
    harness: { registry: registry as never, models: host.models.catalog }, env: options.env ?? runEnv,
  });
  const harness = durable.harness as unknown as Harness;
  const taskHarness = durable.harness as never;
  opened = harness;
  try {
    await status({ source: 'browser', reconciled: await browser.reconcile(harness, () => true, ctx) });
    // agentrun-pi gap: start() reaches the task saved under the key without comparing its request, so a different job
    // on this directory would get the saved job's outcome. Refused here as the driver refuses a moved binding.
    const saved = await flow.read(taskHarness, place.id, ctx);
    const refusal = saved && moved((await harness.getTask(saved.taskId as never, ctx))?.input as WorkflowRequest | undefined, job);
    if (refusal) return { ...refusal, generation: durable.generation, usage: await harness.usage(ctx) };
    reconciled();
    const outcome = await (await flow.start(taskHarness, { key: place.id, workflow: job.workflow, input: job.input }, ctx)).wait(ctx);
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

/** The driver's binding-mismatch refusal when the saved run's workflow or input is not this job's, with the two digests
 *  of each side: the workflow's binding and the input's canonical hash. */
function moved(saved: WorkflowRequest | undefined, job: Job): Extract<WorkflowOutcome, { status: 'refused' }> | undefined {
  if (!saved) return undefined;
  const digests = (request: { workflow: Workflow; input: Record<string, unknown>; bind?: Record<string, unknown> }) => ({ binding: recoveryBinding(request.workflow, request.bind), input: canonicalHash(request.input) });
  const [before, now] = [digests(saved), digests(job)];
  if (before.binding === now.binding && before.input === now.input) return undefined;
  const error = bindingMismatch(JSON.stringify(before), now);
  return { status: 'refused', code: error.code, message: error.message, detail: { moved: (error as { moved?: unknown }).moved ?? null, saved: before, requested: now } };
}

/** Completes each call a killed process left unknown with what the host's door answered it, as an operator reconciles
 *  one, before the task's driver opens the journal. A call the door never answered stays unknown. The journal is opened
 *  under the task's own request, so a different job the host is about to refuse cannot fail the saved run. */
async function settle({ key, taskId, runtime, context }: WorkflowInvocation, answered: NonNullable<Host['tools']['answered']>) {
  const request = (await runtime.getTask(taskId, context))?.input as WorkflowRequest | undefined;
  if (!request) return;
  const commit = async <T,>(change: (tx: never) => T | Promise<T>) => {
    let result!: T;
    await runtime.commit(async (tx) => { result = await change(tx as never); return undefined; }, context);
    return result;
  };
  const journal = await documentStore({ commit } as never, key, { context }).open(recoveryBound(request.workflow, request.bind));
  try {
    for (const effect of journal.effects()) {
      const answer = effect.status === 'unknown' && effect.intent ? await answered(effect.intent) : undefined;
      if (answer) await journal.complete(effect.id, { value: answer.value, files: {}, intent: { tool: effect.intent!.tool, args: answer.args } });
    }
  } finally {
    await journal.close();
  }
}
