// Learning. An agentic revision with `learning: auto` or `approve` gives its agent one bare git repository beside the agent
// store, `<data>/agents/<id>/learning.git`, opened through @parcha/pi-git-remote's local remote. The revision holds what a
// person wrote; the repository holds what the agent learned (notes, INDEX.md, the skills it wrote, workflow drafts, memos).
// Its main carries AGENTS.md and agent.json, which the host writes for the agent's current revision, so a clone made
// outside this server still reads as the agent's. Each run starts from main at one commit, which it journals in its own
// store, and the server proposes what the run learned as `runs/<run id>` once the run's process has let go of its store.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { LearningMode, Revision } from "@parcha/pi-durable-agent";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import type { AppContext, BeforeResume } from "@parcha/pi-durable-disk";
import type { ProposeResult } from "@parcha/pi-agent-learn";
import type { GitIdentity, Repo } from "@parcha/pi-git-remote";
import { type AgentEntry, definitionOf } from "./agents.js";
import { readJson, RUN_META } from "./files.js";
import type { Status } from "./runs.js";
import { isObject } from "./validate.js";

export const LEARN_TOOL = "learn";
const REPO = "learning.git";
/** The server's own clone of an agent's repository: under the agent's directory, never reachable from a run's work. */
const HOST_CLONE = "host.git";
/** A run's own clone, beside its store and outside its work, so no tool of the run can reach it. */
const RUN_CLONE = "learning.git";
const IDENTITY: GitIdentity = { name: "agentrun-serve", email: "serve@agentrun.invalid" };
/** The tools whose calls bring nothing from outside the run into it. A call of any other tool (`fetch_page`, the
 *  browser's, or one this list does not know) makes the run untrusted. */
const TRUSTED_TOOLS = new Set(["read", "write", "edit", "ask_person", LEARN_TOOL]);
/** A skill the agent wrote, at `.agents/skills/<name>/SKILL.md` on main. */
const LEARNED_SKILL = /^\.agents\/skills\/([a-z0-9][a-z0-9._-]{0,63})\/SKILL\.md$/;
/** The variables whose values are this host's secrets, which no learning may hold. */
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i;
/** A value under 8 characters is not checked: it is a placeholder or no secret (a gateway's `AGENT_MODEL_API_KEY=none`),
 *  checking it would refuse ordinary words such as "none", and the guard refuses every write while it is given one. 8 is
 *  pi-browser's redaction floor too. */
const MIN_SECRET = 8;

/** pi-git-remote's floor. */
const MIN_GIT = [2, 40] as const;
const gitChecks = new Map<string, Promise<string | undefined>>();

/** Why this host cannot keep a learning repository, or undefined when it can: git `MIN_GIT` or later on `env`'s PATH. */
export function learningBlocker(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const key = env.PATH ?? "";
  let check = gitChecks.get(key);
  if (!check) {
    const floor = MIN_GIT.join(".");
    check = promisify(execFile)("git", ["--version"], { env }).then(
      ({ stdout }) => {
        const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(stdout) ?? []).slice(1).map(Number);
        return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]) ? undefined : `Learning needs git ${floor} or later, and this host has ${stdout.trim()}.`;
      },
      () => `Learning needs git ${floor} or later on PATH, and this host has none.`,
    );
    gitChecks.set(key, check);
  }
  return check;
}

/** How a revision's runs learn: only an agentic revision learns, and a revision without the field does not. */
export const learningOf = (revision: Revision | null | undefined): LearningMode => (revision?.kind === "agentic" ? (revision.body.learning ?? "off") : "off");

export const repoOf = (data: string, agentId: string): string => join(data, "agents", agentId, REPO);

/** A run's outcome as its memo says it: serve's `cancelled` is the layout's `stopped`. */
export const outcomeOf = (status: Status | string): "completed" | "failed" | "stopped" => (status === "completed" ? "completed" : status === "cancelled" ? "stopped" : "failed");

/** Whether the run read content from outside it: it called a tool other than the file tools, `ask_person` and `learn`. */
export const untrustedOf = (rows: readonly Pick<TimelineEvent, "kind" | "tool_name">[]): boolean =>
  rows.some((row) => row.kind === "tool_use" && typeof row.tool_name === "string" && !TRUSTED_TOOLS.has(row.tool_name));

/** The values of `env`'s keys, tokens, secrets and passwords. */
export const secretsOf = (env: NodeJS.ProcessEnv): string[] =>
  [...new Set(Object.entries(env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value ?? ""))].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);

/** The run's input values: a learning states the rule, and never repeats the case. */
export const caseValuesOf = (input: unknown): string[] => (isObject(input) ? Object.values(input).filter((value): value is string => typeof value === "string") : []);

/** One write at a time per repository in this process: the host commit and the proposals. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => queues.get(key) === settled && queues.delete(key));
  return next;
}

/** The agent's bare repository, made empty on first use, and a clone of it in `clone`. */
async function openAgentRepo(bare: string, clone: string): Promise<Repo> {
  const { local, openRepo } = await import("@parcha/pi-git-remote");
  if (!existsSync(bare)) {
    await mkdir(dirname(bare), { recursive: true, mode: 0o700 });
    await promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", "init", "-q", "--bare", "--template=", "-b", "main", bare]);
  }
  return openRepo({ dir: clone, remote: local(bare), identity: IDENTITY });
}

/** The host's commit on main of `entry`'s current revision: AGENTS.md (its instructions) and agent.json (its definition).
 *  Nothing for an agent that does not learn or on a host that cannot, and no commit when main holds both already. Main's
 *  other files stay. */
export async function hostCommit(data: string, entry: AgentEntry): Promise<{ sha: string; created: boolean } | undefined> {
  const { agent, revision, version } = entry;
  if (!revision || revision.kind !== "agentic" || learningOf(revision) === "off" || (await learningBlocker(process.env))) return undefined;
  const bare = repoOf(data, agent.id);
  return serial(bare, async () => {
    const repo = await openAgentRepo(bare, join(dirname(bare), HOST_CLONE));
    const files = { "AGENTS.md": `${revision.body.instructions.trim()}\n`, "agent.json": `${JSON.stringify(definitionOf(agent, revision, version), null, 2)}\n` };
    const made = await repo.commitTo("main", { files, message: `host: revision ${version} of ${agent.id}`, trailers: { Revision: revision.id } });
    if (made.created) await repo.push(made.sha, "main");
    return made;
  });
}

/** Before a run of `revision` (number `version`) of `entry`'s agent starts: when it learns, main holds the current
 *  revision's host commit, or the run's own when the current one does not learn and main has none yet. */
export async function readyToRun(data: string, entry: AgentEntry, revision: Revision, version: number): Promise<void> {
  if (learningOf(revision) === "off") return;
  if (learningOf(entry.revision) !== "off") return void (await hostCommit(data, entry));
  const bare = repoOf(data, entry.agent.id);
  const main = existsSync(bare) ? await promisify(execFile)("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", "main^{commit}"]).then(() => true, () => false) : false;
  if (!main) await hostCommit(data, { ...entry, revision, version });
}

/** A run's released store as `proposeLearning` reads it: each document's latest value, read-only. */
function releasedStore(file: string) {
  return {
    snapshot: async (doc: { definition: { kind: string } }) => {
      const { recordingLines } = await import("@parcha/agentrun-pi/durable");
      return recordingLines(file).lines.findLast((line) => line.kind === doc.definition.kind)?.data?.value;
    },
  };
}

export type ProposeRunOptions = {
  data: string;
  agentId: string;
  runId: string;
  /** The run's store, which no process holds any more. */
  storeFile: string;
  outcome: Status;
  costUsd?: number;
  untrusted: boolean;
  /** Plaintext values the server holds as secrets, and the run's input values: the guard refuses a note holding one. */
  secrets: readonly string[];
  caseValues: readonly string[];
};

/** What the run learned, proposed as `runs/<run id>` from the commit it was seeded from, with the host's memo. The
 *  `Run-Id` trailer makes a second call for the same run answer `already`. */
export async function proposeRun(options: ProposeRunOptions): Promise<ProposeResult> {
  if (!existsSync(options.storeFile)) return { status: "empty" };
  const bare = repoOf(options.data, options.agentId);
  return serial(bare, async () => {
    const [{ proposeLearning }, repo] = await Promise.all([import("@parcha/pi-agent-learn"), openAgentRepo(bare, join(dirname(bare), HOST_CLONE))]);
    return proposeLearning({
      repo, runId: options.runId, target: releasedStore(options.storeFile) as never, outcome: outcomeOf(options.outcome), untrusted: options.untrusted,
      secrets: options.secrets, caseValues: options.caseValues, ...(options.costUsd === undefined ? {} : { costUsd: options.costUsd }),
    });
  });
}

/** What a learning run's process adds: the `learn` tool and the `<learned>` section, the skills the agent wrote (their
 *  files, under the run's work), and the hook that journals the seed before the run resumes. */
export type RunLearning = { extension: Extension; tools: readonly ToolRegistration[]; skillFiles: string[]; beforeResume(run: BeforeResume): Promise<void> };

/**
 * For the run in `where`, of agent `agentId`: the commit it starts from, which is the one its store journaled when it
 * was seeded before, else main now. The skills the agent wrote at that commit are copied into the run's work, except
 * those named like one of `ownSkills` (the revision's, which win), and `beforeResume` journals the commit and copies
 * the active notes to `<work>/.agent/learnings/`.
 */
export async function runLearning(where: AppContext, agentId: string, ownSkills: readonly string[], storeFile: string, env: NodeJS.ProcessEnv): Promise<RunLearning> {
  const [learn, { modeRefusal }, meta] = await Promise.all([import("@parcha/pi-agent-learn"), import("@parcha/pi-git-remote"), readJson(join(where.root, RUN_META))]);
  const bare = repoOf(resolve(where.root, "..", ".."), agentId);
  if (!existsSync(bare)) throw new Error(`the agent ${agentId} learns, and its repository ${REPO} is not there`);
  const repo = await openAgentRepo(bare, join(where.root, RUN_CLONE));
  await repo.fetch();
  const journaled = existsSync(storeFile) ? ((await releasedStore(storeFile).snapshot(learn.SeedDoc as never)) as { sha?: string } | undefined)?.sha : undefined;
  const sha = journaled || (await repo.resolve("main"));
  if (!sha) throw new Error(`the agent ${agentId}'s repository has no main`);
  const skillFiles: string[] = [];
  for (const entry of await repo.list(".agents/skills", sha)) {
    const name = LEARNED_SKILL.exec(entry.path)?.[1];
    if (!name || ownSkills.includes(name) || entry.type !== "blob" || modeRefusal(entry.mode) || (entry.size ?? 0) > learn.CAPS.file) continue;
    const text = await repo.read(entry.path, sha);
    if (text === undefined) continue;
    await mkdir(join(where.work, ".agents", "skills", name), { recursive: true });
    await writeFile(join(where.work, ".agents", "skills", name, "SKILL.md"), text);
    skillFiles.push(`${name}/SKILL.md`);
  }
  const caseValues = caseValuesOf(meta?.input);
  const extension = learn.agentLearn({ guard: learn.guard, secrets: () => secretsOf(env), caseValues: () => caseValues }) as unknown as Extension;
  return {
    extension,
    tools: extension.tools ?? [],
    skillFiles,
    beforeResume: async ({ harness }) => void (await learn.seedLearning({ repo, ref: sha, target: harness as never, into: where.work })),
  };
}
