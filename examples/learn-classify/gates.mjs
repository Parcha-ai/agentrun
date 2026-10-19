// The two gates the old tune loop had on a learned workflow and pi-agent-learn does not, host-side: a workflow is admitted
// only when the host's own dry run of the saved revision passes, and only when Jev says it does not name a specific
// company or case. Both run before the package's admitter; promotion stays the package's.
import { dryRunWorkflow } from '@parcha/agentrun-dsl';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LEAK_QUESTION = 'Does this workflow name or single out a specific company, brand, website, domain, ticker or filing, or carry a fixed answer for one, rather than working the same way for any company?';
/** A yes at or above `refuse` refuses the workflow; at or below `pass` it may be admitted; between, it is held. */
export const LEAK_CUTS = Object.freeze({ refuse: 0.5, pass: 0.2 });

const STORE_DIR = '.pi/agentrun/workflows';

/** The revision a run ended on, read back through the DSL's store in a scratch directory, never parsed here. */
async function loadRevision(workflow, tmpRoot) {
  const dir = await mkdtemp(join(tmpRoot ?? tmpdir(), 'learn-classify-gate-'));
  try {
    await mkdir(join(dir, STORE_DIR, workflow.name), { recursive: true });
    for (const [file, text] of Object.entries(workflow.records)) {
      if (file.includes('/') || file.startsWith('.')) return undefined;
      await writeFile(join(dir, STORE_DIR, workflow.name, file), text);
    }
    return await new WorkflowStore(dir).load(workflow.name);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The DSL's dry run on synthetic values: no model, Jev or tool call. Code never runs in this process here. */
export async function dryRunStatus(document) {
  const refuseCode = async (_node, _state, context) => { throw new Error(`code node "${context.label}" does not run in a dry run here`); };
  const result = await dryRunWorkflow(document, { runCode: refuseCode });
  const status = !result.ok ? 'failed' : result.skipped?.length ? 'not_run' : 'passed';
  return { status, problems: result.problems ?? [], skipped: result.skipped ?? [] };
}

/** Jev's yes-probability that the document names a specific company or case. */
export async function leakProbability(judge, document) {
  const result = await judge({
    label: 'learn-classify leak gate', kind: 'judge', state: { workflow: document },
    questions: { namesCase: { type: 'noul', instructions: LEAK_QUESTION } },
  });
  const p = result?.answers?.namesCase?.noul;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('the leak gate got no yes-probability back');
  return p;
}

/**
 * The curator's `admitWorkflow` port with the two gates in front of `base` (the package's `workflowAdmitter`). A call with
 * no records only describes a revision main already holds, and goes straight to `base`. A record the store refuses goes
 * to `base` too, which refuses it with its own reason. Every reason names no value from the case.
 */
export function gatedAdmitter({ judge, base, tmpRoot, cuts = LEAK_CUTS }) {
  return async (input) => {
    const { workflow } = input;
    if (!Object.keys(workflow.records ?? {}).length) return base(input);
    const saved = await loadRevision(workflow, tmpRoot);
    if (!saved) return base(input);
    const dry = await dryRunStatus(saved.workflow);
    if (dry.status !== 'passed') return { status: 'refused', reason: `gate dry-run: the host's dry run of ${saved.digest.slice(0, 12)} ${dry.status === 'failed' ? 'failed' : 'did not run every check'}` };
    const p = await leakProbability(judge, saved.workflow);
    if (p >= cuts.refuse) return { status: 'refused', reason: `gate leak: Jev says ${saved.digest.slice(0, 12)} names a specific company or case (${p.toFixed(2)})` };
    if (p > cuts.pass) return { status: 'held', reason: `gate leak: Jev is not sure ${saved.digest.slice(0, 12)} works for any company (${p.toFixed(2)})` };
    return base(input);
  };
}
