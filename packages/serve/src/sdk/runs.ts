// Backend SDK calls remain in their application. This inbox only records their evidence and immutable completion;
// the ordinary fenced runner owns journals, reflection, checking and learning commits.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { ApiError, invalid } from "../errors.js";
import { canonical, isObject, type AgenticBody } from "../store/agent-body.js";
import type { Claim, RunOrigin, Store } from "../store/store.js";
import type { AgentEntry } from "../agents-store.js";
import { uuidv7 } from "../agents-store.js";
import { launchBody, type RunLaunch } from "../run-launch.js";
import { learningStartFor, type StartDeps } from "../runs-over-store.js";
import { labelsIssues, labelsOf } from "../run-labels.js";
import { learnsWorkflowsOf } from "../learning-setting.js";
import { chooseWorkflows, type LearnedWorkflow, chooseSkills, learningFolderOf, readerOf, seedFrom, secretsShown } from "../learning.js";
import { NATIVE_GRADE_INSTRUCTION_BYTES } from "../learn/grade.js";
import { secretRedactor } from "../runner/redact.js";
import { redactedOutput } from "../key-refusal.js";
import { decodedStrings, draftProblems, servedSkill } from "../learn/skills.js";

import { sdkWorkflowManifest, sdkDraftTools } from "./workflows.js";

export type SdkRuntime = "claude-agent-sdk" | "codex-sdk";
export type SdkUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
};
export type SdkEvent =
  | { type: "text"; text: string }
  | { type: "session"; session_id: string }
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
  model?: string;
  session_id?: string;
  usage?: SdkUsage;
};
export type SdkInbox = {
  run_id: string;
  created_at: number;
  expires_at: number;
  batches: { sequence: number; events: SdkEvent[] }[];
  /** Exact approved skill files delivered by the start receipt; absent on older SDK runs. */
  learning_skills?: SdkSeedSkill[];
  /** Exact approved executable workflows delivered by the start receipt. */
  learning_workflows?: LearnedWorkflow[];
  completion?: SdkCompletion;
  /** Internal terminal admission fence. No later evidence can be newly acknowledged after this CAS wins. */
  closed?: "expired" | "failed" | "cancelled";
};
type SdkSeedSkill = { name: string; files: Record<string, string> };
const keyOf = (id: string) => `sdk-run:${id}`;
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
export const sdkOf = (body: unknown): { runtime: SdkRuntime } | undefined =>
  isObject(body) && isObject(body.sdk) && (body.sdk.runtime === "claude-agent-sdk" || body.sdk.runtime === "codex-sdk")
    ? { runtime: body.sdk.runtime }
    : undefined;
export async function sdkInbox(store: Pick<Store, "settings">, runId: string): Promise<SdkInbox> {
  const row = await store.settings.get(keyOf(runId));
  if (!isObject(row)) throw new ApiError("not_found", "No backend SDK run with that id.");
  return row as unknown as SdkInbox;
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

const sign = (secret: string, runId: string) => `ar_sdk_${createHmac("sha256", secret).update(`sdk-run\0${runId}`).digest("base64url")}`;
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
  ) {}
  token(runId: string): string {
    return sign(this.secret, runId);
  }
  async authenticate(runId: string, token: string): Promise<void> {
    // Every key compared, on equal-length digests, with no early return.
    const given = digest(token);
    let ok = false;
    for (const key of [this.secret, ...this.earlier]) ok = timingSafeEqual(given, digest(sign(key, runId))) || ok;
    if (!ok) throw new ApiError("unauthenticated", "This credential is scoped to a different SDK run.");
    await sdkInbox(this.store, runId);
  }
  private clean<T>(body: T, runId?: string): T {
    const redact = secretRedactor([...this.secrets(), ...(runId ? [this.secret, ...this.earlier].map((key) => sign(key, runId)) : [])]);
    // Redact values structurally: a long string or encoded credential can be withheld whole,
    // so treating serialized JSON as prose could remove its delimiters and corrupt the envelope.
    return redactedOutput(body, redact.heldValues?.() ?? []) as T;
  }
  async start(
    entry: AgentEntry,
    body: Record<string, unknown>,
    deps: StartDeps,
    origin: RunOrigin | undefined,
    checkGrade: (model: string) => Promise<void>,
    consoleOrigin: string,
  ) {
    only(body, ["runtime", "input", "instructions", "model", "workflow_tools", "workflow_adapters", "started_at", "title", "labels"]);
    const workflow = sdkWorkflowManifest(body.workflow_tools, body.workflow_adapters);
    if (workflow && canonical(this.clean(workflow)) !== canonical(workflow))
      refuse("The workflow manifest contains a protected value; keep credentials in the backend.");
    const binding = sdkOf(entry.revision?.body);
    if (!binding || !entry.revision)
      throw new ApiError("agent_not_runnable", "This agent is not registered as a backend SDK agent.");
    if (entry.agent.archivedAt !== null) throw new ApiError("agent_archived", "This SDK agent is archived.");
    if (body.runtime !== binding.runtime) refuse("The SDK runtime must match the registered agent.");
    const input = text(body.input, "input"),
      instructions = text(body.instructions, "instructions");
    const model = body.model === undefined ? undefined : text(body.model, "model", 256);
    const startedAt = body.started_at === undefined ? undefined : this.startedAt(body.started_at);
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
    const cleanedInput = this.clean({ input }).input;
    const pinned = await deps.pinnedOf(entry, {});
    if (!pinned) throw new ApiError("agent_not_runnable", "The SDK definition has no current revision.");
    const revisionBody = entry.revision.body as AgenticBody;
    if (revisionBody.maxCostUsd !== undefined)
      throw new ApiError(
        "agent_not_runnable",
        "AgentRun cannot enforce a spend cap on an external SDK. Configure the budget in the backend SDK and remove this managed run cap.",
      );
    const learning = await learningStartFor(
      deps,
      entry,
      pinned.revision,
      { ...revisionBody, ...(!workflow && learnsWorkflowsOf(revisionBody.learning) ? { learning: "notes" } : {}) } as never,
      { content: cleanedInput },
    );
    if (learning) {
      if (Buffer.byteLength(instructions) > NATIVE_GRADE_INSTRUCTION_BYTES)
        refuse(
          "Original SDK instructions exceed the 64 KiB grading evidence limit. Keep learning off or provide a complete policy within that limit.",
        );
      if (!learning.gradeModel)
        throw new ApiError(
          "agent_not_runnable",
          "Self-improving SDK runs need a server grading model and its model key. Configure the grading model or turn self-improving off.",
        );
      await checkGrade(learning.gradeModel);
      if (learning.seedFailed)
        throw new ApiError(
          "unavailable",
          "The learning seed could not be read. Retry after restoring the agent learning folder.",
        );
    }
    const skills = learning ? await this.selectedSkills(entry.agent.id, learning.seed) : [];
    const workflows = learning && !learning.notesOnly && workflow ? await this.selectedWorkflows(entry.agent.id, learning.seed, workflow) : [];
    const cleaned = this.clean({ instructions, ...(model ? { model } : {}) });
    const runId = uuidv7();
    const launch: RunLaunch = {
      input: { content: cleanedInput },
      title: title === undefined ? cleanedInput.trim().replace(/\s+/g, " ").slice(0, 80) : this.clean({ title }).title,
      place: { mode: "runner" },
      harness: "sdk",
      sdk: {
        runtime: binding.runtime,
        ...workflow,
        instructions: cleaned.instructions,
        ...(cleaned.model ? { model: cleaned.model } : {}),
      },
      ...(learning ? { learning: { ...learning, skills: skills.map((skill) => skill.name), workflows: workflows.map((flow) => flow.name) } } : {}),
    };
    const now = Date.now();
    await this.store.settings.put(keyOf(runId), {
      run_id: runId,
      created_at: now,
      expires_at: now + SDK_OPEN_MS,
      batches: [],
      learning_skills: skills,
      learning_workflows: workflows,
    } satisfies SdkInbox);
    try {
      await this.store.runs.create(
        { id: runId, agentId: entry.agent.id, revisionId: entry.revision.id, ...(origin ? { origin } : {}), ...(labels ? { labels } : {}), ...(startedAt !== undefined ? { startedAt } : {}) },
        { body: launchBody(launch) },
      );
    } catch (error) {
      await this.store.settings.remove(keyOf(runId));
      throw error;
    }
    return this.receipt(runId, consoleOrigin);
  }
  /** A start's `started_at`: when the backend began the task, if before this request. The run's `created_at` takes it. */
  private startedAt(value: unknown): number {
    const at = typeof value === "string" ? rfc3339(value) : undefined;
    if (at === undefined) return refuse("started_at must be an RFC 3339 date-time, such as 2026-01-02T03:04:05Z.");
    const now = Date.now();
    if (at > now + STARTED_SKEW_MS) refuse("started_at must not be in the future.");
    if (at < now - STARTED_BACK_MS) refuse("started_at must be at most 7 days ago.");
    return Math.min(at, now);
  }
  async receipt(runId: string, consoleOrigin: string) {
    const run = await this.store.runs.get(runId);
    if (!run) throw new ApiError("not_found", "SDK run not found.");
    const launch = (await this.store.runs.launch(runId)).body as unknown as RunLaunch;
    let inbox = await sdkInbox(this.store, runId);
    if (inbox.learning_skills === undefined) {
      // Older runs did not persist their delivered files. Pin a receipt from their original
      // commit now; do not claim these reconstructed files were supplied on an earlier attempt.
      const skills = launch.learning ? await this.selectedSkills(run.agentId, launch.learning.seed) : [];
      await this.modify(runId, (row) =>
        row.learning_skills === undefined ? { ...row, learning_skills: skills } : row,
      );
      inbox = await sdkInbox(this.store, runId);
    }
    const skills = inbox.learning_skills ?? [];
    // Older SDK receipts never included executable workflows. Do not retroactively deliver one.
    const workflows = inbox.learning_workflows ?? [];
    const shown = secretsShown(this.secrets(), { local: true });
    if (
      shown.holds(launch.learning?.section ?? "") ||
      workflows.some((flow) => {
        const decoded = decodedStrings(flow.workflow);
        return shown.holds(flow.name) || shown.holds(flow.description) || shown.holds(flow.workflow) || decoded === "too_deep" || decoded.some(shown.holds);
      }) ||
      skills.some(
        (skill) =>
          shown.holds(skill.name) ||
          Object.entries(skill.files).some(
            ([path, text]) =>
              shown.holds(path) || shown.holds(text) || (path === "SKILL.md" && shown.holds(servedSkill(text))),
          ),
      )
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
        skills,
        workflows,
      },
    };
  }
  private async selectedWorkflows(agentId: string, revision: string | null, binding: NonNullable<ReturnType<typeof sdkWorkflowManifest>>): Promise<LearnedWorkflow[]> {
    const folder = learningFolderOf(this.data, agentId);
    try {
      const seed = await seedFrom(revision, readerOf(folder.workspace));
      const { flows } = chooseWorkflows(seed, secretsShown(this.secrets(), { local: true }));
      const dsl = await import("@parcha/agentrun-dsl");
      const { tools, gated, deniedBy } = sdkDraftTools(binding.workflow_tools);
      let room = 256 * 1024;
      return flows.filter((flow) => {
        const bytes = Buffer.byteLength(JSON.stringify(flow));
        if (bytes > room || draftProblems(dsl, flow.workflow, tools, gated, deniedBy, undefined, binding.workflow_adapters).length) return false;
        room -= bytes;
        return true;
      });
    } finally { await folder.end(); }
  }
  private async selectedSkills(agentId: string, revision: string | null): Promise<SdkSeedSkill[]> {
    const folder = learningFolderOf(this.data, agentId);
    try {
      const seed = await seedFrom(revision, readerOf(folder.workspace));
      const { taken } = await chooseSkills(folder.workspace, seed, [], secretsShown(this.secrets(), { local: true }));
      return taken.map((skill) => ({ name: skill.name, files: { ...skill.files } }));
    } finally {
      await folder.end();
    }
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
    const events = (body.events as unknown[]).map((value: unknown): SdkEvent => {
      if (!isObject(value)) return refuse("An SDK event must be an object.");
      if (value.type === "text") {
        only(value, ["type", "text"]);
        return { type: "text", text: text(value.text, "text") };
      }
      if (value.type === "session") {
        only(value, ["type", "session_id"]);
        return { type: "session", session_id: text(value.session_id, "session_id", 256) };
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
        // Every accepted batch, an empty one too, keeps the inbox open another hour, up to a day after its start.
        const expires = Math.max(row.expires_at, Math.min(Date.now() + SDK_OPEN_MS, row.created_at + SDK_MAX_OPEN_MS));
        return { ...row, batches: [...row.batches, batch], expires_at: expires };
      },
      EVIDENCE_LIMIT,
    );
    return { accepted: true };
  }
  async complete(runId: string, body: Record<string, unknown>) {
    only(body, ["status", "answer", "error", "model", "session_id", "usage", "evidence_complete"]);
    if (body.evidence_complete !== undefined && typeof body.evidence_complete !== "boolean")
      refuse("evidence_complete must be a boolean.");
    if (!["completed", "failed", "cancelled"].includes(String(body.status)))
      refuse("SDK completion status is completed, failed or cancelled.");
    const completion = this.clean(
      {
        status: body.status as SdkCompletion["status"],
        answer: text(body.answer, "answer"),
        ...(body.evidence_complete !== undefined ? { evidence_complete: body.evidence_complete as boolean } : {}),
        ...(body.error !== undefined ? { error: text(body.error, "error", 8000) } : {}),
        ...(body.model !== undefined ? { model: text(body.model, "model", 256) } : {}),
        ...(body.session_id !== undefined ? { session_id: text(body.session_id, "session_id", 256) } : {}),
        ...(body.usage !== undefined ? { usage: usageOf(body.usage) } : {}),
      },
      runId,
    );
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
      return { ...row, completion };
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
