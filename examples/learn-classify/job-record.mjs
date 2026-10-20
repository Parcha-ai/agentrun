// The workflow part of a chart row, computed from one run's agentrun.recording/1 events (the parsed lines of events.jsonl). CLASSIFY-CONTRACT.md "v3: the chart record" defines the
// fields; VIZ-DATA-CONTRACT.md section 1 defines an execution: one `agentrun.workflow` task, its id the run key (`data.input.key`), the latest line per `data.id`.
//   jobRecordOf(events) -> { executions: [{ key, name, revision, outcome, toolCalls, costUsd | null, tokensIn, tokensOut }], workflowShare: 0..1 | null, agentFallback: true | false | null }  (agentFallback: null with no run attempt, else whether the root agent made a job-tool call outside every execution)
// Read-only and structural: it reads document and entry lines, never text.

/** The job tools: the calls that do the job. Not answer, learn, agentrun or submit. */
export const JOB_TOOLS = ['fetch_page', 'search_web', 'browse', 'read_document', 'sic2_groups', 'sic_codes'];
const JOB = new Set(JOB_TOOLS);

/** The terminal outcome of a task, in the v1 words: complete or escalated (completed with that result.status), failed, aborted. Null while the task has not ended. */
function outcomeOf(task) {
  const state = task?.state;
  if (state?.status !== 'terminal') return null;
  const outcome = state.outcome;
  if (outcome?.status === 'completed') return outcome.result?.status === 'escalated' ? 'escalated' : outcome.result?.status === 'complete' ? 'complete' : null;
  return outcome?.status === 'failed' || outcome?.status === 'aborted' ? outcome.status : null;
}

const parsed = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '');

/** Each `agentrun` call, in order: its action, and its result paired by call id (an error result is none). */
function agentrunCalls(events) {
  const calls = new Map();
  const order = [];
  for (const line of events) {
    if (line?.kind === 'pi.assistant') {
      for (const part of line.data?.model?.[0]?.content ?? []) {
        if (part?.type === 'toolCall' && part.name === 'agentrun' && part.id && !calls.has(part.id)) { const call = { id: part.id, action: part.arguments?.action, sends: part.arguments?.workflow !== undefined, result: undefined }; calls.set(part.id, call); order.push(call); }
      }
    } else if (line?.kind === 'pi.tool-result') {
      for (const message of line.data?.model ?? []) {
        const call = calls.get(message?.toolCallId);
        if (call && !message.isError) call.result = parsed(textOf(message.content));
      }
    }
  }
  return order;
}

/** The name and revision of an execution: the draft held when its run was called is the last `load` or `inspect` of a workflow before that run (the run's answer carries its key), each paired with its result by call id.
 *  A `load` result names a saved workflow: its name and saved digest. An `inspect` that sent a workflow replaced the draft: a draft, name null and the inspection sha256 from the run key (agentrun:<conv>:<sha256>:<input hash>[:n]),
 *  as is a run with neither. (The contract's words are "the last load before the run"; a load followed by an inspect of another workflow ran the inspected one, which is no saved revision.) */
function identityOf(key, calls) {
  const at = calls.findIndex((call) => call.action === 'run' && call.result?.run?.key === key);
  const held = at < 0 ? undefined : calls.slice(0, at).findLast((call) => call.result && ((call.action === 'load' && call.result.saved?.digest) || (call.action === 'inspect' && call.sends)));
  if (held?.action === 'load') return { name: held.result.saved.name ?? null, revision: held.result.saved.digest };
  return { name: null, revision: key.split(':')[2] ?? null };
}

/** Cost and tokens of a set of conversations from their latest pi.usage line (tokensIn counts cached reads and writes, as the row's does). costUsd is null when any bucket is unpriced or any model answer ended in an error or an abort (billed, perhaps, and not priced). */
function usageOf(convs, usageByConv, unpricedByConv) {
  let costUsd = 0, tokensIn = 0, tokensOut = 0, priced = true;
  for (const conv of convs) {
    const usage = usageByConv.get(conv);
    for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
      for (const each of Object.values(bucket)) {
        if (typeof each?.cost?.total === 'number' && Number.isFinite(each.cost.total)) costUsd += each.cost.total; else priced = false;
        tokensIn += (each?.input ?? 0) + (each?.cacheRead ?? 0) + (each?.cacheWrite ?? 0);
        tokensOut += each?.output ?? 0;
      }
    }
    if (unpricedByConv.get(conv)) priced = false;
  }
  return { costUsd: priced ? costUsd : null, tokensIn, tokensOut };
}

export function jobRecordOf(events) {
  // The latest line per task, per document key and per usage conversation.
  const tasks = new Map();
  const nodes = new Map();
  const effects = new Map();
  const usageByConv = new Map();
  const unpricedByConv = new Map();
  const jobCalls = new Map(); // conv -> the call ids of its job-tool calls
  for (const line of events) {
    if (line?.kind === 'agentrun.workflow' && line.data?.id !== undefined) tasks.set(line.data.id, line.data);
    else if (line?.kind === 'agentrun.nodes' && typeof line.data?.key === 'string') nodes.set(line.data.key, line.data.value);
    else if (line?.kind === 'agentrun.effects' && typeof line.data?.key === 'string') effects.set(line.data.key, line.data.value);
    else if (line?.kind === 'pi.usage' && line.conv !== undefined) usageByConv.set(line.conv, line.data?.value);
    else if (line?.kind === 'pi.assistant' && line.conv !== undefined) {
      const message = line.data?.model?.[0];
      if (['error', 'aborted'].includes(message?.stopReason)) unpricedByConv.set(line.conv, true);
      for (const part of message?.content ?? []) {
        if (part?.type === 'toolCall' && JOB.has(part.name) && part.id) { if (!jobCalls.has(line.conv)) jobCalls.set(line.conv, new Set()); jobCalls.get(line.conv).add(part.id); }
      }
    }
  }
  const calls = agentrunCalls(events);
  const attempts = calls.filter((call) => call.action === 'run').length;
  const nodeConvs = new Set();
  const executions = [];
  let inside = 0;
  for (const task of [...tasks.values()].sort((a, b) => a.id - b.id)) {
    const key = task.input?.key;
    if (typeof key !== 'string') continue;
    // The execution's conversations: every node attempt keyed under its run key (maps and child workflows included).
    const convs = [...new Set([...nodes].filter(([nodeKey]) => nodeKey.startsWith(`${key}:`)).map(([, value]) => value?.conversation).filter((conv) => conv !== undefined))];
    for (const conv of convs) nodeConvs.add(conv);
    // Job tools called by `call` nodes are effects keyed under the run key.
    const viaEffects = [...effects].filter(([effectKey, value]) => effectKey.split('\u0000')[0] === key && JOB.has(value?.intent?.tool)).length;
    const toolCalls = convs.reduce((sum, conv) => sum + (jobCalls.get(conv)?.size ?? 0), 0) + viaEffects;
    inside += toolCalls;
    executions.push({ key, ...identityOf(key, calls), outcome: outcomeOf(task), toolCalls, ...usageOf(convs, usageByConv, unpricedByConv) });
  }
  // The root agent's own job calls: those of every conversation that is not a node of an execution.
  let root = 0;
  for (const [conv, ids] of jobCalls) if (!nodeConvs.has(conv)) root += ids.size;
  const total = inside + root;
  return {
    executions,
    workflowShare: total === 0 ? null : inside / total,
    // Over attempts, not executions: an attempt is an `agentrun` run call (paired by call id), whether it executed, was refused at its own inspection or failed before it executed.
    agentFallback: attempts === 0 ? null : root > 0,
  };
}
