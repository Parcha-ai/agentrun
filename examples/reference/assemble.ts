// The reference assembly: one job on pi-durable through the open packages, wired from a host's functions. It holds no
// job and no fake. Order: install every extension, open the run on its directory (pi resumes what a killed process
// left), reconcile the browser, run the workflow, deliver, release the browser's sessions, close, release the run.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, defineDoc, type ConversationId, type Extension, type Harness } from '@earendil-works/pi-durable';
import { runWorkflow, type Workflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery } from '@parcha/agentrun-dsl/recovery';
import { documentStore, hostScope, nodeRunner } from '@parcha/agentrun-pi/durable';
import { ArchilCodingTools, archilEnv, openClaimDir, openDurableRun, type Claim, type RunEnv, type RunRef } from '@parcha/pi-durable-disk';
import { createBrowserExtension } from '@parcha/pi-browser/durable';
import { createVisionExtension } from '@parcha/pi-vision/durable';
import type { Host, RunPlace, StatusEvent } from './host.ts';

export type Job = { workflow: Workflow; input: Record<string, unknown>; files?: Record<string, Uint8Array> };
export type RunResult = {
  status: string;
  output?: unknown;
  generation: number;
  usage: Awaited<ReturnType<Harness['usage']>>;
};

/** The work a conversation does, which names its evidence directory for the browser and for vision alike. */
const Label = defineDoc<{ label: string }>({ kind: 'reference.label', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ label: '' }) });
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 };

/** A place under `root`, or a fresh one under the temp directory. */
export async function placeAt(root?: string): Promise<RunPlace> {
  const at = root ?? await mkdtemp(join(tmpdir(), 'agentrun-reference-'));
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
  // Until the browser's pi range admits 1.1.0 (#336), this process loads pi-durable 1.0.4 (here, the browser, vision) and
  // two 1.1.0 copies (the node runner, the disk run). The values cross them unchanged; their branded types do not, so the
  // four crossings below are cast: extensions into the registry, the registry into the run, the Harness out and back in.
  const registry = createRegistry();
  for (const extension of [ArchilCodingTools, ...host.tools.extensions, vision.extension, browser.extension, nodes.extension] as Extension[]) registry.install(extension);

  // The job's files, in `work/`; one a killed process already placed is kept.
  for (const [name, bytes] of Object.entries(job.files ?? {})) {
    await mkdir(dirname(join(place.work, name)), { recursive: true });
    await writeFile(join(place.work, name), bytes, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  }
  const durable = await openDurableRun({ disk: 'local', region: 'local', id: place.id }, {
    mountToken: 'unused', acquire: async ({ ref }) => localClaim(ref, place), claimDir: (root) => openClaimDir(root, { fstype: null }),
    harness: { registry: registry as never, models: host.models.catalog }, env: options.env ?? runEnv,
  });
  const harness = durable.harness as unknown as Harness;
  opened = harness;
  try {
    await status({ source: 'browser', reconciled: await browser.reconcile(harness, () => true, ctx) });
    const result = await runJob(harness, nodes, host, job, place.id, status);
    if (result.status === 'complete') await host.deliver({ record: result.output });
    return {
      status: result.status, ...(result.status === 'complete' ? { output: result.output } : {}),
      generation: durable.generation, usage: await harness.usage(ctx),
    };
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

/** The workflow under the recovery driver, its LLM steps through the node runner. */
async function runJob(harness: Harness, nodes: ReturnType<typeof nodeRunner>, host: Host, job: Job, key: string, status: (event: StatusEvent) => Promise<void>) {
  const driver = await openRecovery(documentStore(harness as never, key), job.workflow, { key });
  try {
    const deps = withRecovery(driver, {
      runEffect: host.tools.runEffect,
      runNode: nodes.on(hostScope(harness as never), ctx).runNode,
      runJudge: host.decisions.runJudge,
      onEvent: (event) => void status({ source: 'workflow', event }),
    }, { durableNodes: true });
    return await runWorkflow(job.workflow, job.input, deps);
  } finally {
    await driver.close();
  }
}
