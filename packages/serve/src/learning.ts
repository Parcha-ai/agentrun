// Learning: an agent whose definition says `learning: true` keeps what it learned, and each of its runs starts from it.
// It is kept as versioned rows in the store (Store.learning; learn/rows.ts reads and writes them as files):
//   - corrections.md, its owner's standing corrections (learn/corrections.ts): every run of the agent is served it whole
//     under `# Learned` (laidLearned), cut of the host's secrets;
//   - workflows/<name>/, the workflows its runs compiled (learn/compile.ts): a run whose input one fits is answered by it
//     (runner/workflow-first.ts).
// When a run of such an agent is made, the server reads its newest save (its first, empty, made when there is none);
// the run's launch keeps the save it started from and its # Learned text.
import { CORRECTIONS_FILE, decodedStrings, frontMatter, learnedSecretShapes, type Problem, redactLearned, valueMatcher } from "./learn/index.js";
import { type AgentLearning, type LearningRead, readAt, readOf } from "./learn/rows.js";
import { agentFolderOf, serialBy } from "./files.js";
import { withoutLoopbackAddresses } from "./key-refusal.js";
import { DETAIL_MAX, LIST_DETAIL, said, short, wordsOf } from "./learning-words.js";

export { learnsOf } from "./learning-setting.js";

/** The server's learning switch (`--learning`, AGENTRUN_SERVE_LEARNING; capabilities.features.learning). `on`, the
 *  default: a run learns when its agent's definition says `learning: true`. `off`: no run this server starts does. */
export const LEARNING_MODES = ["on", "off"] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];
export const LEARNING_ENV = "AGENTRUN_SERVE_LEARNING";
/** The switch: `given`, else AGENTRUN_SERVE_LEARNING, else on. Any other value is an error, and the server does not start. */
export function learningOf(env: NodeJS.ProcessEnv, given?: string): LearningMode {
  const value = given ?? (env[LEARNING_ENV] || "on");
  if (!(LEARNING_MODES as readonly string[]).includes(value)) throw new Error(`learning is on or off (--learning, ${LEARNING_ENV}), not ${value}`);
  return value as LearningMode;
}

/** Where a run's learning stands (its `learning`, runs.ts): `seeded` once it starts from what its agent learned,
 *  `reflecting` while its end-of-run step runs (its compile turn, its owner's correction), `merged` once what it learned
 *  is on main, or `dropped` with a reason from the closed list. A learning fault never refuses a run: it starts with
 *  nothing learned, `seed_failed`. */
export const LEARNING_STATES = ["seeded", "reflecting", "merged", "dropped"] as const;
export const LEARNING_REASONS = ["seed_failed", "no_budget", "unknown_cost", "cancelled", "crashed", "reflect_failed", "empty", "checker", "use", "reset", "purged_since_seed"] as const;
/** A run's own `learning` on its start (POST /agents/{agent_id}/runs): it starts from what its agent learned, as a run that
 *  learns does, and keeps nothing (no compile, no correction, at any end), so runs of one agent read one learned state
 *  however many run at once. Its learning ends `dropped`, reason `use`. */
export const RUN_LEARNING_USE = "use";
export type LearningState = (typeof LEARNING_STATES)[number];
export type LearningReason = (typeof LEARNING_REASONS)[number];
/** Tokens by the platform's names, as a run's metrics and /v2/stats count them: `input` is the input neither read from
 *  nor written to the cache. */
export type Tokens = { input: number; cache_read: number; cache_write: number; output: number };
/** A run's learning as the store keeps it. Past the view's four fields: the checks' `problems` (printable), the merge
 *  commit, and once it merged the workflow draft it wrote (`workflows`) or the corrections it added (`corrections`, the
 *  lines). */
export type Learning = {
  state: LearningState; reason: LearningReason | null; detail: string | null; at: string;
  problems?: Problem[]; merged?: string;
  /** Once its end-of-run step asked its compile turn: when its job's answer was final, and what the run had cost by then
   *  (null when unknown); once that turn ended, what the turn itself cost (null when unknown). */
  answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null;
  /** A merge's workflow draft, by name and the path of its workflow.json; `pending` when it waits for a person's OK
   *  (`status: pending` in its README.md), and no run is given it until approved. */
  workflows?: LearnedFile[];
  /** How many lines of its owner's words a merge added to corrections.md. */
  corrections?: number;
  /** The compile turn's record, when the run's end-of-run turn wrote the agent's job as a learned workflow
   *  (learn/compile.ts): the workflow, and each attempt with what the checks refused. */
  compiled?: LearningCompiled;
  /** What the checks refused of a compiled draft that never passed: never silent, on the run's learning and its API. */
  draft_errors?: string[];
};
/** A compile turn's record (learn/compile.ts CompiledRecord): `digest`, the kept draft's; `promoted`, read from the agent's
 *  promotion records when the run's learning is read, absent while undecided. */
export type LearningCompiled = { workflow: string; attempts: { ok: boolean; errors: string[] }[]; digest?: string; promoted?: boolean };
/** A workflow draft a merge added or changed. */
export type LearnedFile = { file: string; name: string; pending?: true };

/** What a text or a name that leaves shows of the host's secrets now: none (secretsShown). */
export type Shown = { text: (text: string) => string; name: (name: string) => string; holds: (text: string) => boolean };
/** What a name holding a secret reads: learn/secrets.ts redactSecrets' mark, the name's whole, never a part of it. */
const REDACTED = "[redacted]";
/** The host's secrets as a reader cuts them: a text holding a value or a shape is cut of it (whole when long:
 *  learn/secrets.ts redactLearned, a bank's numbers too), and a file's name holding one reads REDACTED whole; any other
 *  text or name is shown as it is. A text served has no loopback address (key-refusal.ts withoutLoopbackAddresses): the
 *  host's own, never a person's. `local`: kept, for what a run itself is given (its # Learned section), where an address
 *  on the run's own machine is the owner's to give. */
export function secretsShown(values: readonly string[], { local = false }: { local?: boolean } = {}): Shown {
  const matches = valueMatcher(values);
  // Every shape learning refuses, a bank's numbers beside their words too (learnedSecretShapes).
  const holds = (text: string) => matches(text) || learnedSecretShapes(text).length > 0;
  const cut = (text: string) => (holds(text) ? redactLearned(text, values) : text);
  return { holds, text: local ? cut : (text) => withoutLoopbackAddresses(cut(text)), name: (name) => (holds(name) ? REDACTED : name) };
}

const isText = (value: unknown): value is string => typeof value === "string";
/** The workflow draft a run merged, as a view or a list shows it (each `pending` while it waits), each name cut of the
 *  host's secrets (`shown`), only when it holds one. The stored ones are read as untrusted: an entry out of shape is
 *  left out. */
export function filesView({ state, workflows }: Learning, shown: Shown): { workflows?: LearnedFile[] } {
  const drafts = state === "merged" && Array.isArray(workflows) ? workflows.filter((item) => isText(item?.file) && isText(item.name)).map(({ file, name, pending: waits }) => ({ file: shown.name(file), name: shown.name(name), ...(waits === true ? { pending: true as const } : {}) })) : [];
  return drafts.length ? { workflows: drafts } : {};
}
/** A draft's status on main (its README.md's). */
export type ItemStatus = { status: string };
/** Whether a run's learning held anything for its owner's OK: a merge with a held draft. Only such a run's reads check
 *  main (currentLearning). */
export const holdsForOk = (learning: Learning | undefined): learning is Learning =>
  learning?.state === "merged" && (Array.isArray(learning.workflows) ? learning.workflows : []).some((item) => item?.pending);

/** A merged run's learning as it reads now: what it held for the owner's OK checked against each draft's status on main
 *  now (`status`, by its workflow.json). Still pending, it waits; approved (active), it is learned, as a merge that held
 *  nothing says it; retired or gone, it is no longer said. No status (the folder unread): as written. */
export function currentLearning(learning: Learning, status: ReadonlyMap<string, ItemStatus> | undefined): Learning {
  if (!status || learning.state !== "merged" || !Array.isArray(learning.workflows)) return learning;
  const of = (file: unknown) => (typeof file === "string" ? status.get(file)?.status : undefined);
  const workflows = learning.workflows.flatMap((item) => (!item?.pending || of(item.file) === "pending" ? [item] : of(item.file) === "active" ? [{ file: item.file, name: item.name }] : []));
  const gone = !workflows.length && !learning.corrections;
  return { ...learning, ...(gone ? { detail: said.retiredSince } : {}), workflows };
}

/** A run's learning in a person's words as a read shows them (learning-words.ts wordsOf): each part cut of the host's
 *  secrets as they are now (`shown`) first, then the words cut short to `max`, so a secret is never shown in part. */
export const detailShown = (learning: Learning, shown: Shown, max = DETAIL_MAX): string | null => {
  const words = wordsOf(learning, shown.text);
  return words === null ? null : short(words, max);
};
/** A run's learning as its view shows it: the state, why in a person's words (detailShown), when, and the draft it
 *  merged (filesView). */
export const learningView = (learning: Learning, shown: Shown) => {
  const { state, reason, at } = learning;
  return { state, reason: reasonShown(reason, shown), detail: detailShown(learning, shown), at, ...filesView(learning, shown) };
};
/** A learning's `reason` as it is served: one of its words as the server writes them, read back from a kept row, which is
 *  untrusted, so cut of the host's secrets as every text is. */
export const reasonShown = (reason: Learning["reason"] | undefined, shown: Shown): Learning["reason"] => (typeof reason === "string" ? (shown.text(reason) as Learning["reason"]) : (reason ?? null));
/** A run's learning as its view shows it, in short for a list: all of it but its time, its detail cut short. */
export function shortOf<T extends { state: LearningState; reason: LearningReason | null; detail: string | null; at: string }>({ state, reason, detail, at: _, ...rest }: T) {
  return { state, reason, detail: detail === null ? null : short(detail, LIST_DETAIL), ...rest };
}
/** The label of the end-of-run turn's timeline rows, and the kind and label of a run's learning row. */
export const LEARNING_LABEL = "learning";
/** The most characters a message's `said` holds (POST /runs/{id}/messages): the person's own words beside a host's
 *  `content`, which the run's learning keeps as one line of corrections.md. */
export const SAID_MAX = 4_000;

/** A message a trigger sent the run that its owner did not write (a webhook body, a Slack or GitHub event), by its
 *  source: never what the user said. */
export type Triggered = { source: string; text: string };

/** What a run is seeded from: main's commit (null when the folder has none yet), corrections.md's text ("" when none),
 *  and its active learned workflows, by name. `at`: when a run's seed was read (seedOf, epoch ms, in the agent's
 *  learning queue), which the agent's reset watermark is set in too: a seed read at or before it predates the reset. */
export type Seed = { sha: string | null; corrections: string; workflows: LearnedWorkflow[]; at?: number };
/** A workflow the agent learned, as a run may run it: its name, the line its README says what it does with, and its
 *  workflow.json whole. */
export type LearnedWorkflow = { name: string; description: string; workflow: string };
/** The most bytes the `learned_workflow` tool's description gives its workflows, each one's line (workflowLine)
 *  together: every harness sends the description with each request, so it never grows with what an agent learned. */
export const LEARNED_WORKFLOWS_BUDGET = 8 * 1024;
/** A learned workflow's line in the `learned_workflow` tool's description: its name, its input's fields (inputFields;
 *  none for a workflow whose input names no schema) and what its README says it does. One line: the tool's own line says
 *  once that `*` marks a required field. */
export const workflowLine = ({ name, description, workflow }: Pick<LearnedWorkflow, "name" | "description"> & { workflow?: string }): string => {
  const fields = inputFields(workflow);
  return `- ${name}${fields ? ` ${fields}` : ""}: ${description || "(no description)"}`;
};

/** The most of a field's description a workflow's input line carries. */
const FIELD_DESCRIPTION = 60;

/** A workflow's input as its line in learned_workflow's description says it: its input schema, compact (compactSchema),
 *  so a call names the fields the workflow takes; none for a workflow whose input names no schema. */
function inputFields(workflow: string | undefined): string | undefined {
  let doc: { schemas?: Record<string, unknown>; input?: { schemaId?: unknown } } | undefined;
  try {
    doc = workflow ? JSON.parse(workflow) : undefined;
  } catch {
    return undefined;
  }
  const id = doc?.input?.schemaId;
  const schema = typeof id === "string" ? doc?.schemas?.[id] : undefined;
  return schema ? compactSchema(schema, doc?.schemas ?? {}, 0, definitionsOf(schema)) : undefined;
}

/** A schema's own inline definitions (`definitions`, `$defs`), which its `#/definitions/` references read first. */
const definitionsOf = (schema: unknown): Record<string, unknown> => {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  return { ...((s.$defs as Record<string, unknown> | undefined) ?? {}), ...((s.definitions as Record<string, unknown> | undefined) ?? {}) };
};

/** A JSON Schema in one line: an object's fields as `name type`, a required one marked `*`, each with its description cut
 *  short; an array as `array of <items>`; a reference to another of the workflow's schemas followed, two levels deep. */
function compactSchema(schema: unknown, schemas: Record<string, unknown>, depth = 0, defs: Record<string, unknown> = {}): string {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : undefined;
  if (!s) return "any";
  if (typeof s.$ref === "string") {
    // As the DSL resolves it: `#/definitions/` and `#/$defs/` in the schema's own inline definitions first, then the
    // workflow's schemas by that name.
    const inline = /^#\/(?:definitions|\$defs)\//.test(s.$ref);
    const name = s.$ref.replace(/^#\/(?:schemas|definitions|\$defs)\//, "");
    const target = (inline ? defs[name] : undefined) ?? schemas[name];
    return depth > 2 || !target ? name : compactSchema(target, schemas, depth + 1, defs);
  }
  if (s.properties && typeof s.properties === "object") {
    if (depth > 2) return "object";
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const fields = Object.entries(s.properties as Record<string, unknown>).map(([key, value]) => {
      const said = value && typeof value === "object" ? (value as Record<string, unknown>).description : undefined;
      const words = typeof said === "string" && said.trim() ? ` "${said.trim().length > FIELD_DESCRIPTION ? `${said.trim().slice(0, FIELD_DESCRIPTION - 1)}…` : said.trim()}"` : "";
      return `${key}${required.has(key) ? "*" : ""} ${compactSchema(value, schemas, depth + 1, defs)}${words}`;
    });
    return `{${fields.join(", ")}}`;
  }
  if (s.type === "array") return `array of ${compactSchema(s.items, schemas, depth + 1, defs)}`;
  if (Array.isArray(s.enum)) return s.enum.map((value) => JSON.stringify(value)).join("|");
  return typeof s.type === "string" ? s.type : Array.isArray(s.type) ? s.type.join("|") : "any";
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `work` once every call queued before it on agent `agentId`'s learning has finished: one at a time per agent, in
 *  this process. A run's seed read and a reset of the agent's learning (learning-reset.ts) go through it, so a seed is
 *  read wholly before a reset or wholly after. Keyed by the agent's folder (files.ts agentFolderOf): two ids that
 *  differ only in case share one queue. */
export const inLearningQueue = <T>(data: string, agentId: string, work: () => Promise<T>): Promise<T> => serialBy(queues, agentFolderOf(data, agentId), work);

/** The seed of a read (its view undefined: no save yet): corrections.md, and each active draft's README.md and
 *  workflow.json. A draft whose README's front matter does not read one way is never read as active. */
function seedIn(read: LearningRead): Seed {
  const corrections = read.text(CORRECTIONS_FILE) ?? "";
  const workflows: LearnedWorkflow[] = [];
  for (const item of read.view?.workflows ?? []) {
    if (item.status !== "active") continue;
    const readme = read.text(item.file);
    const json = read.text(item.files.find((file) => file.path.endsWith("/workflow.json"))?.path ?? "");
    if (readme === undefined || json === undefined) continue;
    const front = frontMatter(readme);
    if (!front) continue;
    workflows.push({ name: item.name, description: front.get("description") ?? "", workflow: json });
  }
  return { sha: read.view?.main ?? null, corrections, workflows };
}

/** The seed of a run of agent `agentId` about to be made: its learning's newest save (its first, empty, made when it has
 *  none, so every seed names one), what it holds for a run (seedIn), and when it was read (`at`). In the agent's queue, as
 *  a reset is (learning-reset.ts). */
export function seedOf(data: string, store: { readonly learning: Pick<AgentLearning["rows"], "seed"> }, agentId: string): Promise<Seed> {
  return inLearningQueue(data, agentId, async () => ({ ...seedIn(readOf(await store.learning.seed(agentId))), at: Date.now() }));
}

/** What save `save` of the agent's learning holds for a run, as seedOf reads the newest, read now: a purged run's
 *  workflow is gone from it. No save (null) is the empty seed; a save the agent's learning no longer holds throws. */
export async function seedAt(learning: AgentLearning, save: string | null): Promise<Seed> {
  if (save === null) return { sha: null, corrections: "", workflows: [] };
  const read = await readAt(learning, save);
  if (!read) throw new Error(`the agent's learning holds no save ${save}`);
  return seedIn(read);
}

/** Whether `text` holds a host secret (`shown`): as written, or, read as JSON, in any string it decodes to (its escapes
 *  decoded), or nested past the bound. The one check a learned workflow's text passes at a run's start (chooseWorkflows)
 *  and every text its compile turn is told (runner/learning-end.ts compileAskOf); a text that is not JSON is read as
 *  written. */
export const holdsSecret = (text: string, shown: Shown): boolean => {
  const decoded = decodedStrings(text);
  return shown.holds(text) || decoded === "too_deep" || decoded.some(shown.holds);
};

/** Which of `seed`'s learned workflows a run may run (its `learned_workflow` tool), in the seed's order: each while its
 *  line (workflowLine) fits what is left of the tool's description budget (LEARNED_WORKFLOWS_BUDGET). One that does not,
 *  or holds a host secret (`shown`), is left out and named in `left`, but for one whose name is itself a secret, never
 *  named. */
export function chooseWorkflows(seed: Seed, shown: Shown): { flows: LearnedWorkflow[]; left: string[] } {
  const flows: LearnedWorkflow[] = [];
  const left: string[] = [];
  let room = LEARNED_WORKFLOWS_BUDGET;
  for (const flow of seed.workflows) {
    if (holdsSecret(flow.workflow, shown) || shown.holds(flow.description) || shown.holds(flow.name)) {
      if (!shown.holds(flow.name)) left.push(flow.name);
      continue;
    }
    const bytes = Buffer.byteLength(`${workflowLine(flow)}\n`, "utf8");
    if (bytes > room) left.push(flow.name);
    else (room -= bytes), flows.push(flow);
  }
  return { flows, left };
}

/** A run's # Learned text from its seed: corrections.md whole, each line cut of the host's secrets (`shown`). Empty when
 *  the owner corrected nothing yet. */
export const learnedSection = (seed: Pick<Seed, "corrections">, shown: Shown): string => seed.corrections.trim() ? seed.corrections.split("\n").map(shown.text).join("\n").trim() : "";

/** The heading of what a run learned, in its instructions. */
export const LEARNED_HEADING = "# Learned";
/** What every run that learns is told first under it: what follows is its owner's word. */
const CORRECTIONS_INTRO = "Your owner's standing corrections from earlier runs, one per line. Follow each one that applies.";
/** What a run whose owner corrected nothing yet is told in place of them. */
const NOTHING_YET = "Nothing learned yet.";

/** A run's instructions with its # Learned section laid in: the revision's instructions, then the heading, and its owner's
 *  corrections (CORRECTIONS_INTRO, then the section), or "Nothing learned yet." when there are none (or a seed that could
 *  not be read). Shared so every harness lays the same bytes. */
export const laidLearned = (instructions: string, section: string | undefined): string =>
  `${instructions.trim()}\n\n${LEARNED_HEADING}\n\n${section ? `${CORRECTIONS_INTRO}\n\n${section}` : NOTHING_YET}`;
