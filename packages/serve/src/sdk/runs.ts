// Backend SDK calls remain in their application. This inbox only records their evidence and immutable completion;
// the ordinary fenced runner owns journals, reflection, checking and learning commits.
import { cliCaptureOf } from "../source-sync/capture.js";
import { sourceKey } from "../source-sync/registry.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { inspectWorkflow, resolveSchemaForWorkflow } from "@parcha/agentrun-dsl";
import { ApiError, invalid } from "../errors.js";
import { canonical, isObject, cliLearningOf, learningSettingForBody, type AgenticBody } from "../store/agent-body.js";
import type { Claim, RunOrigin, Store, SettingsGuard } from "../store/store.js";
import type { AgentEntry } from "../agents-store.js";
import { uuidv7 } from "../ids.js";
import { launchBody, type RunLaunch } from "../run-launch.js";
import { learningStartFor, type StartDeps } from "../runs-over-store.js";
import { labelsIssues, labelsOf } from "../run-labels.js";
import { chooseWorkflows, inLearningQueue, type LearnedWorkflow, seedAt, secretsShown } from "../learning.js";
import { INSTRUCTION_EVIDENCE_BYTES } from "../native/instructions.js";
import { CLI_POLICY_BYTES } from "../cli-learning/policy.js";
import { refuseWhileNoRunner } from "../runner/presence.js";
import { secretRedactor } from "../runner/redact.js";
import { redactedOutput } from "../key-refusal.js";
import { decodedStrings, draftProblems } from "../learn/workflow-draft.js";
import { learningOf, type LearningRead, readAt } from "../learn/rows.js";
import { purgedRun, purgedRows } from "../purged-workflow.js";

import { sdkWorkflowManifest, sdkDraftTools } from "./workflows.js";
import type { SdkWorkflowCheckEvent } from "./check.js";
import { promotionOf, promotionsOf, resetAtOf } from "../learn/promote.js";
import { championTextOf, releaseSdkCheck, reserveSdkCheck, type SdkWorkflowCheck } from "../runner/promotion.js";
import { sdkTakes, workflowDigest } from "../runner/workflow-first.js";

import { SDK_WORKFLOW_RUNTIMES, sdkBindingOf, type SdkBinding } from "./runtimes.js";
export { SDK_RUNTIMES, isSdkRuntime, type SdkRuntime } from "./runtimes.js";
export type SdkUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
};
export type SdkEvent =
  | SdkWorkflowCheckEvent
  | { type: "text"; text: string }
  | { type: "session"; session_id: string }
  | { type: "message"; role: "user" | "assistant"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      status: "started" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
      parent_tool_use_id?: string;
    };
export type SdkCompletion = {
  status: "completed" | "failed" | "cancelled";
  answer: string;
  error?: string;
  evidence_complete?: boolean;
  seed_observed?: boolean;
  seed_revision?: string;
  /** Claude records the effective same-prompt policy only after UserPromptSubmit. */
  source_policy?: {instructions:string;complete:boolean};
  model?: string;
  session_id?: string;
  usage?: SdkUsage;
};
/** Claude's begin snapshot is provisional; only its immutable same-window completion can establish policy. */
export function cliPolicyOf(launch:RunLaunch,completion?:SdkCompletion):{instructions:string;complete:boolean}|undefined {
  const cli=launch.cli_learning;
  if(!cli)return undefined;
  return cli.runtime==="claude-code-cli" ? completion?.source_policy ?? {instructions:"The current Claude prompt policy was not captured.",complete:false} : {instructions:cli.instructions,complete:cli.policy_complete};
}
export type SdkInbox = {
  run_id: string;
  created_at: number;
  expires_at: number;
  batches: { sequence: number; events: SdkEvent[] }[];
  /** Exact promoted executable workflows delivered by the start receipt. */
  learning_workflows?: LearnedWorkflow[];
  /** The runs whose text learning_workflows and learning_check's draft are: a receipt sent again after one of them is
   *  purged answers 410 purged (receipt). */
  learning_writers?: string[];
  /** A compiled draft reserved for a shadow check, never supplied to the native agent. */
  learning_check?: SdkWorkflowCheck;
  /** Server cleaning changed evidence: two different secret-bearing answers must never agree by their placeholder. */
  check_redacted?: true;
  completion?: SdkCompletion;
  /** CLI source evidence was withheld by the redactor; never infer learning from that partial trace. */
  evidence_incomplete?: true;
  /** Internal terminal admission fence. No later evidence can be newly acknowledged after this CAS wins. */
  closed?: "expired" | "failed" | "cancelled";
};
const keyOf = (id: string) => `sdk-run:${id}`;
/** The settings key an SDK run's record is kept under (the run's delete with its agent's: agent-delete.ts). */
export const sdkRunKey = keyOf;
/** An inbox takes evidence until an hour after its start or its latest events batch, and never past a day after its start. */
const SDK_OPEN_MS = 3_600_000;
export const SDK_MAX_OPEN_MS = 86_400_000;
/** A start's `started_at`: at most this far ahead of the server's clock, at most this far behind it. */
const STARTED_SKEW_MS = 60_000,
  STARTED_BACK_MS = 7 * 86_400_000;
const TITLE_LIMIT = 200;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const TEXT_LIMIT = 128_000,
  BATCH_LIMIT = 256_000,
  TOTAL_LIMIT = 4_000_000;
// Always leave enough room for bounded completion after an evidence upload reaches its limit.
const EVIDENCE_LIMIT = TOTAL_LIMIT - 600_000;
const refuse = (message: string): never => {
  throw new ApiError("input_invalid", message);
};
const text = (value: unknown, name: string, max = TEXT_LIMIT): string =>
  typeof value === "string" && value.length <= max
    ? value
    : refuse(`${name} must be text of at most ${max} characters.`);
const only = (body: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(body).some((key) => !keys.includes(key))) refuse("Unknown SDK request field.");
};
const usageOf = (value: unknown): SdkUsage | undefined => {
  if (value === undefined) return undefined;
  if (!isObject(value)) return refuse("usage must be an object.");
  const keys = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd"] as const;
  only(value, keys);
  const result = {} as SdkUsage;
  for (const key of keys) {
    const n = value[key];
    if (
      n !== undefined &&
      n !== null &&
      (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (key !== "cost_usd" && !Number.isSafeInteger(n)))
    )
      return refuse("Usage counters must be nonnegative numbers or null.");
    result[key] = n === undefined ? null : (n as number | null);
  }
  return result;
};
/** An RFC 3339 date-time as epoch ms, or undefined when it is not one (a field out of range included). */
function rfc3339(value: string): number | undefined {
  const m = RFC3339.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return undefined;
  if (m[8] && (Number(m[9]) > 23 || Number(m[10]) > 59)) return undefined;
  const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * 60_000 : 0;
  return Date.UTC(y, mo - 1, d, h, mi, s, Math.floor(Number(`0${m[7] ?? ""}`) * 1000)) - offset;
}
/** A start's `started_at` as epoch ms: its form only, refused when it is not an RFC 3339 date-time. */
const rfc3339Of = (value: unknown): number =>
  (typeof value === "string" ? rfc3339(value) : undefined) ?? refuse("started_at must be an RFC 3339 date-time, such as 2026-01-02T03:04:05Z.");
/** A new start's `started_at` against the server's clock at `now`: when the backend began the task, if before this request.
 *  The run's `created_at` takes it. Never applied to a retry of a start already made (its receipt is returned first). */
const startedWithin = (at: number, now: number): number => {
  if (at > now + STARTED_SKEW_MS) refuse("started_at must not be in the future.");
  if (at < now - STARTED_BACK_MS) refuse("started_at must be at most 7 days ago.");
  return Math.min(at, now);
};
export const sdkOf = (body: unknown): SdkBinding | undefined => isObject(body) ? sdkBindingOf(body.sdk) : undefined;
export async function sdkInbox(store: Pick<Store, "settings">, runId: string): Promise<SdkInbox> {
  const row = await store.settings.get(keyOf(runId));
  if (!isObject(row)) throw new ApiError("not_found", "No backend SDK run with that id.");
  return row as unknown as SdkInbox;
}

/** What every SDK run's inbox holds of run `runId`'s text, gone (its purge): an inbox whose workflows or check draft it
 *  wrote (`learning_writers` names it) keeps none of them, its writers kept, so its receipt answers 410 purged. Run after
 *  the run's purge committed, and a start checks its writers after its inbox is written (start), so one of the two
 *  always sees the other: no inbox keeps a purged run's workflow text. */
export async function forgetSdkCopies(store: Pick<Store, "settings">, runId: string): Promise<void> {
  for (const row of await store.settings.all({ prefix: keyOf("") })) {
    for (let value = row.value, retry = 0; retry < 20; retry++) {
      if (!isObject(value)) break;
      const inbox = value as unknown as SdkInbox;
      if (!inbox.learning_writers?.includes(runId) || (!inbox.learning_workflows?.length && !inbox.learning_check)) break;
      const { learning_check: _check, ...rest } = inbox;
      if (await store.settings.replaceIf(row.key, value, { ...rest, learning_workflows: [] })) break;
      value = await store.settings.get(row.key);
    }
  }
}

/** Completion and closure compete on the same inbox. A stale runner cannot close it, and a completion that won
 *  remains available to the next claim even if this one cannot read or journal it. No external SDK call is replayed.
 *  An expiry is checked against the row it replaces: an events batch that moved the deadline keeps the inbox open. */
export async function closeSdkInbox(store: Pick<Store, "settings">, claim: Claim, reason: NonNullable<SdkInbox["closed"]>): Promise<SdkInbox> {
  for (let retry = 0; retry < 20; retry++) {
    const row = await sdkInbox(store, claim.runId);
    if (row.completion || row.closed) return row;
    if (reason === "expired" && row.expires_at >= Date.now()) return row;
    const next = { ...row, closed: reason };
    if (await store.settings.replaceIf(keyOf(claim.runId), row, next, claim)) return next;
  }
  throw new ApiError("home_busy", "SDK evidence changed concurrently. Retry the same request.");
}

const writableInbox = (row: SdkInbox) => {
  if (row.closed) throw new ApiError("not_continuable", "This SDK run has ended.");
  if (row.expires_at < Date.now()) throw new ApiError("not_continuable", "This SDK run expired.");
};

/** Parents are evidence relationships within this inbox, never caller-chosen labels that hide top-level work. Check
 *  inside modify's compare-and-replace so a concurrent upload cannot change the history we validated. */
function checkToolParents(row: SdkInbox, events: readonly SdkEvent[]): void {
  const calls = new Map<string, { name: string; parent?: string; workflow?: string; open: boolean }>();
  const openChildren = new Map<string, number>();
  const tools = new Map<string, ReadonlySet<string>>();
  for (const event of [...row.batches.flatMap((batch) => batch.events), ...events]) {
    if (event.type !== "tool") continue;
    const previous = calls.get(event.id);
    if (event.status === "started") {
      if (previous) refuse("SDK tool start IDs must be unique within the run.");
      if (event.parent_tool_use_id !== undefined) {
        const parent = calls.get(event.parent_tool_use_id);
        if (!parent?.open || parent.parent !== undefined || parent.name !== "learned_workflow" || !parent.workflow)
          refuse("A nested SDK callback must name an open learned_workflow invocation in this run.");
        const workflow = row.learning_workflows?.find((flow) => flow.name === parent!.workflow)
          ?? refuse("The SDK callback's workflow was not supplied to this run.");
        if (!tools.has(workflow.name)) tools.set(workflow.name, new Set(inspectWorkflow(JSON.parse(workflow.workflow)).requires.tools));
        if (!tools.get(workflow.name)!.has(event.name)) refuse("The SDK callback's tool is not in its pinned workflow.");
        openChildren.set(event.parent_tool_use_id, (openChildren.get(event.parent_tool_use_id) ?? 0) + 1);
      }
      calls.set(event.id, { name: event.name, parent: event.parent_tool_use_id, open: true,
        ...(event.name === "learned_workflow" && isObject(event.input) && typeof event.input.name === "string" ? { workflow: event.input.name } : {}),
      });
    } else {
      if (openChildren.get(event.id)) refuse("SDK workflow callbacks must finish before their parent workflow.");
      if (event.parent_tool_use_id !== undefined || previous?.parent !== undefined) {
        if (!previous?.open || previous.name !== event.name || previous.parent !== event.parent_tool_use_id)
          refuse("A nested SDK result must keep its open call's original name and parent.");
      }
      if (previous) {
        previous.open = false;
        if (previous.parent !== undefined) openChildren.set(previous.parent, openChildren.get(previous.parent)! - 1);
      }
    }
  }
}

/** The key a server signs its SDK runs' credentials with: derived from its seal key (seal-key.ts), which stays the
 *  store's for its life, so adding, reordering or removing an API token (api-token.ts) never changes a run's credential. */
export const sdkRunSecret = (sealKey: Buffer): string => createHmac("sha256", sealKey).update("agentrun sdk-run credentials").digest("base64url");

const sign = (secret: string, runId: string, lane:"sdk"|"cli"="sdk") => `${lane==="cli"?"ar_cli_run_":"ar_sdk_"}${createHmac("sha256", secret).update(`${lane}-run\0${runId}`).digest("base64url")}`;
const digest = (text: string) => createHash("sha256").update(text).digest();

export class SdkRuns {
  /** `earlier` are the keys credentials were once signed with (the server's API tokens, before `secret` was its seal
   *  key's): a credential any of them signed is still taken, so a run started before an upgrade keeps its credential. */
  constructor(
    private readonly store: Store,
    private readonly data: string,
    private readonly secret: string,
    private readonly secrets: () => readonly string[] = () => [],
    private readonly earlier: readonly string[] = [],
    private readonly lane: "sdk" | "cli" = "sdk",
  ) {}
  token(runId: string): string {
    return sign(this.secret, runId, this.lane);
  }
  async authenticate(runId: string, token: string): Promise<void> {
    // Every key compared, on equal-length digests, with no early return.
    const given = digest(token);
    let ok = false;
    for (const key of [this.secret, ...this.earlier]) ok = timingSafeEqual(given, digest(sign(key, runId, this.lane))) || ok;
    if (!ok) throw new ApiError("unauthenticated", "This credential is scoped to a different SDK run.");
    await sdkInbox(this.store, runId);
  }
  private clean<T>(body: T, runId?: string): T {
    const redact = secretRedactor([...this.secrets(), ...(runId ? [this.secret, ...this.earlier].map((key) => sign(key, runId, this.lane)) : [])]);
    // Redact values structurally: a long string or encoded credential can be withheld whole,
    // so treating serialized JSON as prose could remove its delimiters and corrupt the envelope.
    return redactedOutput(body, redact.heldValues?.() ?? []) as T;
  }
  async start(
    entry: AgentEntry,
    body: Record<string, unknown>,
    deps: StartDeps,
    origin: RunOrigin | undefined,
    compile: { readonly model?: string; check(model: string): Promise<void> },
    consoleOrigin: string,
    cli?: NonNullable<RunLaunch["cli_learning"]>,
  ) {
    if (this.lane !== (cli ? "cli" : "sdk")) refuse("The run must use its enrolled credential lane.");
    only(body, cli ? ["runtime", "input", "instructions", "model"] : ["runtime", "platform", "input", "instructions", "model", "workflow_tools", "workflow_adapters", "started_at", "title", "labels"]);
    const source = cli ? undefined : sdkBindingOf(body) ?? refuse("The SDK source needs a supported runtime; external requires a platform label of 1–80 characters without surrounding whitespace, controls or lone surrogates. Other runtimes do not take platform.");
    if (source && !SDK_WORKFLOW_RUNTIMES.includes(source.runtime) && (body.workflow_tools !== undefined || body.workflow_adapters !== undefined))
      refuse("External runs receive owner corrections; workflow_tools and workflow_adapters require a backend workflow bridge.");
    const workflow = cli ? undefined : sdkWorkflowManifest(body.workflow_tools, body.workflow_adapters);
    if (workflow && canonical(this.clean(workflow)) !== canonical(workflow))
      refuse("The workflow manifest contains a protected value; keep credentials in the backend.");
    const expectedCurrent = entry.agent.currentRevision;
    const managedLearning = learningSettingForBody(entry.revision?.body);
    const capture = cli ? await cliCaptureOf(this.store, entry) : undefined;
    const sourceGuards: SettingsGuard[] = cli ? [{ key: `cli-learning-connection:${cli.connection_id}`, fields: { active: true, generation: cli.connection_generation, agent_id: entry.agent.id } }] : [];
    if (capture) {
      entry = { ...entry, revision: capture.revision };
      if (capture.source) sourceGuards.push({ key: sourceKey(entry.agent.id), fields: { id: capture.source.id, capture_revision: capture.source.capture_revision } });
    }
    const binding = sdkOf(entry.revision?.body);
    if (cli) {
      if (cliLearningOf(entry.revision?.body)?.connection_id !== cli.connection_id)
        refuse("CLI connection does not match the enrolled agent.");
      if (body.runtime !== cli.runtime) refuse("The CLI runtime must match the enrolled agent.");
    } else if (!binding || source!.runtime !== binding.runtime || source!.platform !== binding.platform) {
      refuse("The SDK runtime and platform must match the registered agent.");
    }
    if (!entry.revision)
      throw new ApiError("agent_not_runnable", "This agent has no current registered revision.");
    if (entry.agent.archivedAt !== null) throw new ApiError("agent_archived", "This SDK agent is archived.");
    const input = text(body.input, "input"),
      instructions = text(body.instructions, "instructions", cli ? CLI_POLICY_BYTES : TEXT_LIMIT);
    const model = body.model === undefined ? undefined : text(body.model, "model", 256);
    // Its form is checked now; its distance from the clock only for a new start, below: a retry of a start that was made
    // (its origin and fingerprint kept) gets its receipt however late it comes.
    const reportedAt = body.started_at === undefined ? undefined : rfc3339Of(body.started_at);
    const title = body.title === undefined ? undefined : text(body.title, "title").trim().replace(/\s+/g, " ");
    if (title !== undefined && ([...title].length < 1 || [...title].length > TITLE_LIMIT))
      refuse(`title must be text of 1 to ${TITLE_LIMIT} characters.`);
    const labelIssues = labelsIssues(body.labels);
    if (labelIssues.length) throw invalid(labelIssues);
    const labels = labelsOf(body.labels);
    if (labels && canonical(this.clean(labels)) !== canonical(labels))
      refuse("A label contains a protected value; keep credentials in the backend.");
    if (origin) {
      const known = await this.store.runOfOrigin(origin.key);
      if (known) {
        if (known.fingerprint !== origin.fingerprint)
          throw new ApiError("idempotency_mismatch", "The key was used with another SDK start.");
        return this.receipt(known.runId, consoleOrigin);
      }
    }
    const startedAt = reportedAt === undefined ? undefined : startedWithin(reportedAt, Date.now());
    const cleanedInput = this.clean({ input }).input;
    const pinned = await deps.pinnedOf(entry, {});
    if (!pinned) throw new ApiError("agent_not_runnable", "The SDK definition has no current revision.");
    const revisionBody = entry.revision.body as AgenticBody;
    if (revisionBody.maxCostUsd !== undefined)
      throw new ApiError(
        "agent_not_runnable",
        "AgentRun cannot enforce a spend cap on an external SDK. Configure the budget in the backend SDK and remove this managed run cap.",
      );
    // A runner keeps an SDK run's evidence and ends it: while every runner here refused to claim, the start is refused in
    // their words, as any start is (prepareLaunch), before the caller holds a receipt it would run on.
    await refuseWhileNoRunner(this.store.runners);
    // A connected agent's run names no disk.
    const learning = await learningStartFor(deps, entry, pinned.revision, { ...revisionBody, learning: cli ? managedLearning : learningSettingForBody(revisionBody) } as never, {
      disk: null,
      noWorkflows: !workflow,
      ...(compile.model ? { model: compile.model } : {}),
    });
    if (learning) {
      if (Buffer.byteLength(instructions) > (cli ? CLI_POLICY_BYTES : INSTRUCTION_EVIDENCE_BYTES))
        refuse(
          cli ? "Original CLI instructions exceed the 256 KiB evidence limit. Keep capture off or provide a complete policy within that limit." : "Original SDK instructions exceed the 64 KiB learning evidence limit. Keep learning off or provide a complete policy within that limit.",
        );
      if (!cli && !learning.model)
        throw new ApiError(
          "agent_not_runnable",
          "Self-improving SDK runs need a server model and its model key to compile workflows. Configure the model or turn self-improving off.",
        );
      if (!cli) await compile.check(learning.model!);
      if (learning.seedFailed)
        throw new ApiError(
          "unavailable",
          "The learning seed could not be read. Retry the start.",
        );
    }
    const revision = entry.revision;
    const admit = async (): Promise<string> => {
      // The reset deletes the agent's learning in this queue after setting its watermark (learning-reset.ts): a seed
      // read at or before it is of learning the reset deleted, so the start is refused, to start again on a new seed.
      const reset = learning ? await resetAtOf(this.store.settings, entry.agent.id) : undefined;
      if (learning && reset !== undefined && !(learning.seededAt !== undefined && learning.seededAt > reset))
        throw new ApiError("unavailable", "The agent's learning was reset while this run started: start it again.", { retry_after_ms: 1_000 });
      const selected = learning && !learning.noWorkflows && workflow ? await this.selectedWorkflows(entry.agent.id, learning.seed, workflow) : { workflows: [], writers: new Map<LearnedWorkflow, string>(), candidates: [], drafts: {} as Record<string, string> };
      const cleaned = this.clean({ instructions, ...(model ? { model } : {}) });
      const runId = uuidv7();
      const redacted = cleanedInput !== input || cleaned.instructions !== instructions;
      // A turn is a check only when it can be one's baseline: no protected value in its task or policy, and an input the
      // draft takes (sdkTakes). A prose turn whose input the client cannot resolve is given back (releaseSdkCheck).
      const takes = (flow: LearnedWorkflow) => !redacted && sdkTakes(flow, input, resolveSchemaForWorkflow as never);
      const checkDeps = { store: this.store, agentId: entry.agent.id, log: () => {}, shown: async () => secretsShown(this.secrets(), { local: true }) };
      const check = learning ? await reserveSdkCheck(checkDeps, { runId, revision: learning.seed, learning: revisionBody.learning, flows: selected.candidates, takes }) : undefined;
      // A shadow check needs the original agent's own answer, not an answer produced by its existing champion.
      const workflows = check ? [] : selected.workflows;
      const writers = [...new Set([...workflows.map((flow) => selected.writers.get(flow)), check ? selected.drafts[check.workflow.name] : undefined].filter((run): run is string => typeof run === "string"))];
      const launch: RunLaunch = {
        input: { content: cleanedInput },
        title: title === undefined ? cleanedInput.trim().replace(/\s+/g, " ").slice(0, 80) : this.clean({ title }).title,
        place: { mode: "runner" },
        ...(cli ? {
          harness: "cli",
          cli_learning: { ...cli, instructions: cleaned.instructions, policy_complete: cli.policy_complete && cleaned.instructions === instructions, ...(cleaned.model ? { model: cleaned.model } : {}) },
        } : {
          harness: "sdk",
          sdk: { ...binding!, ...workflow, instructions: cleaned.instructions, ...(cleaned.model ? { model: cleaned.model } : {}) },
        }),
        ...(learning ? { learning: { ...learning, workflows: workflows.map((flow) => flow.name) } } : {}),
      };
      const now = Date.now();
      try {
        await this.store.settings.put(keyOf(runId), {
          run_id: runId,
          created_at: now,
          expires_at: now + (cli ? SDK_MAX_OPEN_MS : SDK_OPEN_MS),
          batches: [],
          learning_workflows: workflows,
          ...(writers.length ? { learning_writers: writers } : {}),
          ...(check ? { learning_check: check } : {}),
          ...(redacted ? { check_redacted: true } : {}),
          ...(cli && cleanedInput !== input ? { evidence_incomplete: true } : {}),
        } satisfies SdkInbox);
        // A writer purged since the selection read it (the purge's own scrub of inboxes, forgetSdkCopies, runs after it
        // commits, so it sees this inbox unless this read sees the purge): the start is refused, its inbox removed.
        if (writers.length && (await purgedRows(this.store, writers)).size)
          throw new ApiError("unavailable", "The agent's learning changed while this run started: start it again.", { retry_after_ms: 1_000 });
        await this.store.runs.create(
          { id: runId, agentId: entry.agent.id, revisionId: revision.id, ...(cli ? { expectedCurrent, settingsGuards: sourceGuards } : {}), ...(origin ? { origin } : {}), ...(labels ? { labels } : {}), ...(startedAt !== undefined ? { startedAt } : {}) },
          { body: launchBody(launch) },
        );
      } catch (error) {
        await this.store.settings.remove(keyOf(runId));
        // The reservation comes first because the launch it is created with withholds the champion from a check's turn.
        // No turn ran, so the check waits for the next one, the release uncounted: never a hold of a draft never compared.
        if (check) {
          const record = promotionOf(await promotionsOf(this.store.learning, entry.agent.id).catch(() => []), check.workflow.name, check.digest);
          if (record?.decided === "replaying" && record.replay_id === check.id) await releaseSdkCheck(checkDeps, record, "its start could not be admitted", false).catch(() => undefined);
        }
        // Two source hooks may admit the same immutable prompt window under different transport keys.
        // The store's origin constraint chooses one; recover its receipt (the run it chose) without creating another run.
        if (origin) {
          const known = await this.store.runOfOrigin(origin.key);
          if (known) {
            if (known.fingerprint !== origin.fingerprint)
              throw new ApiError("idempotency_mismatch", "The key was used with another SDK start.");
            return known.runId;
          }
        }
        throw error;
      }
      return runId;
    };
    // A learning start is admitted in its agent's learning queue (learning.ts inLearningQueue), the one a reset of the
    // agent's learning deletes it in: either the reset comes first, and the seed read before it is refused above, or this
    // run's row is made first, and the reset refuses while it goes (409 learning_busy). No check of a draft the reset
    // deleted is reserved, and no run starts on it.
    const runId = learning ? await inLearningQueue(this.data, entry.agent.id, admit) : await admit();
    return this.receipt(runId, consoleOrigin);
  }
  async receipt(runId: string, consoleOrigin: string) {
    const run = await this.store.runs.get(runId);
    if (!run) throw new ApiError("not_found", "SDK run not found.");
    const launch = (await this.store.runs.launch(runId)).body as unknown as RunLaunch;
    const inbox = await sdkInbox(this.store, runId);
    const workflows = inbox.learning_workflows ?? [];
    // A start sent again answers the receipt it pinned, never a workflow a purged run wrote: 410 purged, as its file read.
    const purged = [...(await purgedRows(this.store, inbox.learning_writers ?? [])).values()][0];
    if (purged) throw purgedRun(purged);
    const shown = secretsShown(this.secrets(), { local: true });
    if (
      shown.holds(launch.learning?.section ?? "") ||
      [...workflows, ...(inbox.learning_check ? [inbox.learning_check.workflow] : [])].some((flow) => {
        const decoded = decodedStrings(flow.workflow);
        return shown.holds(flow.name) || shown.holds(flow.description) || shown.holds(flow.workflow) || decoded === "too_deep" || decoded.some(shown.holds);
      })
    )
      throw new ApiError(
        "unavailable",
        "The pinned SDK learning contains a protected value. Start a new run to receive a fresh safe seed.",
      );
    return {
      run_id: runId,
      agent_id: run.agentId,
      console_url: `${consoleOrigin}/#/runs/${encodeURIComponent(runId)}`,
      token: this.token(runId),
      learning: {
        enabled: !!launch.learning,
        revision: launch.learning?.seed ?? null,
        context: launch.learning?.section ?? "",
        workflows,
        ...(inbox.learning_check ? { check: inbox.learning_check } : {}),
      },
    };
  }
  /** The workflows a start delivers, each the seed's or its champion's text read at its record's save, and the run whose
   *  text each is (`writers`); the drafts a check may take, and the run whose text each is (`drafts`, by name). A text and
   *  its writer are two reads, and a purge rewrites the saves they read in place: it adds a save of its own after the
   *  newest (Store.learning purgeRun), so a selection a purge save moved under is read again (a normal save rewrites
   *  nothing it read), and one that keeps moving refuses the start, to start again. Never the purged run's text named as
   *  no run's. */
  private async selectedWorkflows(agentId: string, revision: string | null, binding: NonNullable<ReturnType<typeof sdkWorkflowManifest>>): Promise<{ workflows: LearnedWorkflow[]; writers: Map<LearnedWorkflow, string>; candidates: LearnedWorkflow[]; drafts: Record<string, string> }> {
    const newest = () => this.store.learning.newestPurge(agentId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await newest();
      const selected = await this.selectedOnce(agentId, revision, binding);
      if ((await newest()) === before) return selected;
    }
    throw new ApiError("unavailable", "The agent's learning changed while this run started: start it again.", { retry_after_ms: 1_000 });
  }
  private async selectedOnce(agentId: string, revision: string | null, binding: NonNullable<ReturnType<typeof sdkWorkflowManifest>>): Promise<{ workflows: LearnedWorkflow[]; writers: Map<LearnedWorkflow, string>; candidates: LearnedWorkflow[]; drafts: Record<string, string> }> {
    const learning = learningOf(this.store, agentId);
    const reads = new Map<string, Promise<LearningRead | undefined>>();
    const readSave = (save: string) => reads.get(save) ?? reads.set(save, readAt(learning, save)).get(save)!;
    const writerAt = async (name: string, save: string | null) => (save === null ? undefined : (await readSave(save))?.view?.workflows.find((item) => item.name === name)?.run ?? undefined);
    const seed = await seedAt(learning, revision);
    const { flows } = chooseWorkflows(seed, secretsShown(this.secrets(), { local: true }));
    const dsl = await import("@parcha/agentrun-dsl");
    const { tools, gated, deniedBy } = sdkDraftTools(binding.workflow_tools);
    const records = await promotionsOf(this.store.learning, agentId);
    let room = 256 * 1024;
    const compatible = (flow: LearnedWorkflow) => {
      const bytes = Buffer.byteLength(JSON.stringify(flow));
      if (bytes > room || draftProblems(dsl, flow.workflow, tools, gated, deniedBy, undefined, binding.workflow_adapters).length) return false;
      room -= bytes;
      return true;
    };
    const workflows: LearnedWorkflow[] = [], candidates: LearnedWorkflow[] = [], writers = new Map<LearnedWorkflow, string>(), drafts: Record<string, string> = {};
    const atSave = async (name: string, save: string) =>
      chooseWorkflows(await seedAt(learning, save), secretsShown(this.secrets(), { local: true })).flows.find((one) => one.name === name);
    for (const flow of flows) {
      const { text: serving, champion } = await championTextOf(records, flow, atSave);
      if (serving && compatible(serving)) {
        workflows.push(serving);
        const writer = await writerAt(serving.name, serving === flow ? seed.sha : champion!.commit ?? null);
        if (writer) writers.set(serving, writer);
      }
      if ((!serving || workflowDigest(serving) !== workflowDigest(flow)) && compatible(flow)) {
        candidates.push(flow);
        const writer = await writerAt(flow.name, seed.sha);
        if (writer) drafts[flow.name] = writer;
      }
    }
    return { workflows, writers, candidates, drafts };
  }
  private async modify(runId: string, change: (row: SdkInbox) => SdkInbox, limit = TOTAL_LIMIT): Promise<void> {
    for (let retry = 0; retry < 20; retry++) {
      const old = await sdkInbox(this.store, runId),
        next = change(old);
      if (next === old) return;
      if (Buffer.byteLength(JSON.stringify(next)) > limit)
        throw new ApiError("payload_too_large", "SDK run evidence exceeds its 4 MB limit.");
      if (await this.store.settings.replaceIf(keyOf(runId), old, next)) return;
    }
    throw new ApiError("home_busy", "SDK evidence changed concurrently. Retry the same request.");
  }
  private async writable(runId: string): Promise<void> {
    const run = await this.store.runs.get(runId);
    if (!run || ["ended", "stopped", "failed"].includes(run.state))
      throw new ApiError("not_continuable", "This SDK run has ended.");
    if ((await sdkInbox(this.store, runId)).expires_at < Date.now())
      throw new ApiError("not_continuable", "This SDK run expired.");
  }
  async events(runId: string, body: Record<string, unknown>) {
    only(body, ["sequence", "events"]);
    if (
      !Number.isSafeInteger(body.sequence) ||
      (body.sequence as number) < 1 ||
      !Array.isArray(body.events) ||
      body.events.length > 100
    )
      refuse("Supply a positive sequence and at most 100 events.");
    if (Buffer.byteLength(JSON.stringify(body)) > BATCH_LIMIT)
      throw new ApiError("payload_too_large", "An SDK event batch exceeds 256 KB.");
    const launch = (await this.store.runs.launch(runId)).body as unknown as RunLaunch;
    const events = (body.events as unknown[]).map((value: unknown): SdkEvent => {
      if (!isObject(value)) return refuse("An SDK event must be an object.");
      if (value.type === "message" && launch.cli_learning) {
        only(value,["type","role","text"]);
        if(value.role!=="user"&&value.role!=="assistant")return refuse("A dialogue message role must be user or assistant.");
        return {type:"message",role:value.role,text:text(value.text,"text")};
      }
      if (value.type === "text") {
        only(value, ["type", "text"]);
        return { type: "text", text: text(value.text, "text") };
      }
      if (value.type === "session") {
        only(value, ["type", "session_id"]);
        return { type: "session", session_id: text(value.session_id, "session_id", 256) };
      }
      if (value.type === "workflow_check") {
        only(value, ["type", "id", "digest", "outcome", "answer", "reason", "skipped", "fresh_reads"]);
        if (value.fresh_reads !== undefined && (!Number.isSafeInteger(value.fresh_reads) || (value.fresh_reads as number) < 1 || (value.fresh_reads as number) > 256))
          refuse("fresh_reads must be an integer from 1 to 256 when supplied.");
        if (!["answered", "handed_back", "failed", "skipped_write"].includes(String(value.outcome))) refuse("Invalid workflow check outcome.");
        if (value.outcome === "answered" && typeof value.answer !== "string") refuse("An answered workflow check needs its answer.");
        if (value.skipped !== undefined) {
          if (!isObject(value.skipped)) refuse("A skipped workflow check names its tool.");
          only(value.skipped as Record<string, unknown>, ["tool", "unmarked"]);
          text((value.skipped as Record<string, unknown>).tool, "skipped.tool", 256);
          if ((value.skipped as Record<string, unknown>).unmarked !== undefined && (value.skipped as Record<string, unknown>).unmarked !== true) refuse("skipped.unmarked must be true when supplied.");
        }
        if (value.outcome === "skipped_write" && value.skipped === undefined) refuse("A skipped write names its tool.");
        return { type: "workflow_check", id: text(value.id, "id", 256), digest: text(value.digest, "digest", 256), outcome: value.outcome as SdkWorkflowCheckEvent["outcome"],
          ...(value.answer !== undefined ? { answer: text(value.answer, "answer") } : {}),
          ...(value.reason !== undefined ? { reason: text(value.reason, "reason", 8000) } : {}),
          ...(value.skipped !== undefined ? { skipped: value.skipped as SdkWorkflowCheckEvent["skipped"] } : {}),
          ...(value.fresh_reads !== undefined ? { fresh_reads: value.fresh_reads as number } : {}),
        };
      }
      if (value.type === "tool") {
        only(value, ["type", "id", "name", "status", "input", "output", "parent_tool_use_id"]);
        if (!["started", "completed", "failed"].includes(String(value.status)))
          return refuse("Invalid tool event status.");
        return {
          type: "tool",
          id: text(value.id, "id", 256),
          name: text(value.name, "name", 256),
          status: value.status as "started" | "completed" | "failed",
          ...(value.input !== undefined ? { input: value.input } : {}),
          ...(value.output !== undefined ? { output: value.output } : {}),
          ...(value.parent_tool_use_id !== undefined ? { parent_tool_use_id: text(value.parent_tool_use_id, "parent_tool_use_id", 256) || refuse("parent_tool_use_id must not be empty.") } : {}),
        };
      }
      return refuse("Unsupported SDK event type.");
    });
    const batch = this.clean({ sequence: body.sequence as number, events }, runId);
    const checkRedacted = canonical(events) !== canonical(batch.events);
    const known = (await sdkInbox(this.store, runId)).batches.find((item) => item.sequence === batch.sequence);
    if (known) {
      if (canonical(known) !== canonical(batch))
        throw new ApiError("idempotency_mismatch", "This sequence already has different events.");
      return { accepted: true };
    }
    await this.writable(runId);
    await this.modify(
      runId,
      (row) => {
        const existing = row.batches.find((item) => item.sequence === batch.sequence);
        if (existing) {
          if (canonical(existing) !== canonical(batch))
            throw new ApiError("idempotency_mismatch", "This sequence already has different events.");
          return row;
        }
        writableInbox(row);
        if (row.completion) throw new ApiError("not_continuable", "SDK run completion is already recorded.");
        if (batch.sequence !== row.batches.length + 1)
          throw new ApiError("idempotency_mismatch", "SDK event sequences must be contiguous.");
        checkToolParents(row, batch.events);
        const checks = [...row.batches.flatMap(item => item.events), ...batch.events].filter((event): event is SdkWorkflowCheckEvent => event.type === "workflow_check");
        if (checks.length > 1) refuse("Only one workflow check may be delivered per SDK run.");
        for (const check of checks) if (!row.learning_check || check.id !== row.learning_check.id || check.digest !== row.learning_check.digest)
          refuse("The workflow check must name this SDK run's reserved candidate.");
        // Every accepted batch, an empty one too, keeps the inbox open another hour, up to a day after its start.
        const expires = Math.max(row.expires_at, Math.min(Date.now() + SDK_OPEN_MS, row.created_at + SDK_MAX_OPEN_MS));
        return { ...row, batches: [...row.batches, batch], expires_at: expires, ...(checkRedacted ? { check_redacted: true, ...(launch.cli_learning ? { evidence_incomplete: true as const } : {}) } : {}) };
      },
      EVIDENCE_LIMIT,
    );
    return { accepted: true };
  }
  async complete(runId: string, body: Record<string, unknown>) {
    const launch = (await this.store.runs.launch(runId)).body as unknown as RunLaunch;
    only(body, ["status", "answer", "error", "model", "session_id", "usage", "evidence_complete", ...(launch.cli_learning ? ["seed_observed", "seed_revision"] : []), ...(launch.cli_learning?.runtime==="claude-code-cli"?["source_policy"]:[])]);
    if(body.seed_observed !== undefined && typeof body.seed_observed !== "boolean")refuse("seed_observed must be a boolean.");
    if (body.seed_observed === true && (!launch.learning?.seed || !launch.learning.section.trim() || body.seed_revision !== launch.learning.seed))
      refuse("An observed seed requires pinned owner corrections and the matching revision from this prompt window receipt.");
    if (body.evidence_complete !== undefined && typeof body.evidence_complete !== "boolean")
      refuse("evidence_complete must be a boolean.");
    if (!["completed", "failed", "cancelled"].includes(String(body.status)))
      refuse("SDK completion status is completed, failed or cancelled.");
    if (launch.cli_learning && body.session_id !== undefined && body.session_id !== launch.cli_learning.session_id)
      refuse("The completion session_id must match this CLI prompt window.");
    let sourcePolicy:SdkCompletion["source_policy"];
    if(body.source_policy!==undefined){
      if(!isObject(body.source_policy))refuse("source_policy must be the current Claude prompt snapshot.");
      const policy=body.source_policy as Record<string,unknown>;only(policy,["instructions","complete"]);
      if(typeof policy.complete!=="boolean")refuse("source_policy.complete must be explicit.");
      const instructions=text(policy.instructions,"source_policy.instructions",CLI_POLICY_BYTES);
      if(Buffer.byteLength(instructions)>CLI_POLICY_BYTES)refuse("The CLI source policy exceeds 256 KiB; mark capture incomplete rather than truncating it.");
      sourcePolicy={instructions,complete:policy.complete as boolean};
    }
    const submitted: SdkCompletion = {
        status: body.status as SdkCompletion["status"],
        ...(sourcePolicy?{source_policy:sourcePolicy}:{}),
        answer: text(body.answer, "answer"),
        ...(body.evidence_complete !== undefined ? { evidence_complete: body.evidence_complete as boolean } : {}),
        ...(body.seed_observed !== undefined ? {seed_observed:body.seed_observed as boolean} : {}),
        ...(body.seed_revision !== undefined ? {seed_revision:text(body.seed_revision,"seed_revision",128)} : {}),
        ...(body.error !== undefined ? { error: text(body.error, "error", 8000) } : {}),
        ...(body.model !== undefined ? { model: text(body.model, "model", 256) } : {}),
        ...(body.session_id !== undefined ? { session_id: text(body.session_id, "session_id", 256) } : {}),
        ...(body.usage !== undefined ? { usage: usageOf(body.usage) } : {}),
    };
    const completion = this.clean(submitted, runId);
    // Source policy has its own completeness flag; redacted execution evidence cannot
    // be represented as complete even when the source explicitly claimed it was.
    const { source_policy: _submittedPolicy, ...submittedEvidence } = submitted;
    const { source_policy: _cleanedPolicy, ...cleanedEvidence } = completion;
    const evidenceIncomplete = !!launch.cli_learning && canonical(submittedEvidence) !== canonical(cleanedEvidence);
    if(completion.source_policy && completion.source_policy.instructions !== sourcePolicy!.instructions)completion.source_policy.complete=false;
    const known = (await sdkInbox(this.store, runId)).completion;
    if (known) {
      if (canonical(known) !== canonical(completion))
        throw new ApiError("idempotency_mismatch", "SDK completion is immutable.");
      return { accepted: true };
    }
    await this.writable(runId);
    await this.modify(runId, (row) => {
      if (row.completion) {
        if (canonical(row.completion) !== canonical(completion))
          throw new ApiError("idempotency_mismatch", "SDK completion is immutable.");
        return row;
      }
      writableInbox(row);
      return { ...row, completion, ...(evidenceIncomplete ? { evidence_incomplete: true as const } : {}), ...(completion.answer !== body.answer ? { check_redacted: true } : {}) };
    });
    return { accepted: true };
  }
  async status(runId: string) {
    const run = await this.store.runs.get(runId);
    if (!run) throw new ApiError("not_found", "SDK run not found.");
    const inbox = await sdkInbox(this.store, runId);
    return {
      run_id: runId,
      state:
        run.state === "ended"
          ? "completed"
          : run.state === "failed"
            ? "failed"
            : run.state === "stopped"
              ? "cancelled"
              : inbox.completion
                ? "processing"
                : "running",
      ...((await this.store.runs.get(`${runId}-learning`)) ? { learning_run_id: `${runId}-learning` } : {}),
    };
  }
}
