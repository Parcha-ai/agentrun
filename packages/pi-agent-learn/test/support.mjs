import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { local, openRepo } from "@parcha/pi-git-remote";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { agentLearn, renderLearning, SeedDoc } from "../dist/index.js";

export { ctx, fauxAssistantMessage, fauxText, fauxToolCall };

const roots = [];
after(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A fresh directory for one test, removed when the file's tests end. */
export async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-agent-learn-"));
  await chmod(dir, 0o755);
  roots.push(dir);
  return dir;
}

export const AGENT_FILES = {
  "agent.json": `${JSON.stringify({ version: 1, name: "Registry researcher", instructions: "Cite every claim.", skills: [], tools: [] }, null, 2)}\n`,
  "AGENTS.md": "# Rules\n\nCite every claim. Never store customer data.\n",
};

export const SHA = "0".repeat(40);

/** A learning as curation would write it. */
export function learning(id, text, extra = {}) {
  return { id, type: "lesson", scope: "all", status: "active", provenance: { runs: ["run-1"], sha: SHA, untrusted: false }, uses: 0, supersedes: [], text, ...extra };
}

export function learningFiles(learnings) {
  return Object.fromEntries(learnings.map((l) => [`learnings/${l.id}.md`, renderLearning(l)]));
}

/** A bare remote whose main holds the agent files and `files`, and the host's repository on it. */
export async function agentRepo(root, files = {}) {
  const bare = path.join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "--template=", "-b", "main", bare], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: root } });
  const repo = await openRepo({ dir: path.join(root, "host"), remote: local(bare) });
  const { sha } = await repo.commitTo("main", { files: { ...AGENT_FILES, ...files }, message: "seed the agent repository" });
  await repo.push(sha, "main");
  return { bare, repo, main: sha };
}

/** Plain git on the bare remote: a commit on main that adds `file` as a symlink to `target`, which the package never writes. */
export function plantSymlink(bare, file, target) {
  const env = { PATH: process.env.PATH, GIT_DIR: bare, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: bare, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (args, input) => execFileSync("git", args, { env, input, encoding: "utf8" }).trim();
  const [dir, name] = [path.posix.dirname(file), path.posix.basename(file)];
  const blob = git(["hash-object", "-w", "--stdin"], target);
  const sub = git(["mktree"], `${git(["ls-tree", `main:${dir}`])}\n120000 blob ${blob}\t${name}\n`);
  const top = git(["ls-tree", "main"]).split("\n").map((line) => (line.endsWith(`\t${dir}`) ? `040000 tree ${sub}\t${dir}` : line)).join("\n");
  const commit = git(["commit-tree", git(["mktree"], `${top}\n`), "-p", "main", "-m", "plant a symlink"]);
  git(["update-ref", "refs/heads/main", commit]);
  return commit;
}

/** Commits `files` on main and pushes; returns the new main. */
export async function commitMain(repo, files, message = "curate") {
  const { sha } = await repo.commitTo("main", { files, message });
  await repo.push(sha, "main");
  return sha;
}

/** What the model was shown in its system message: the prompt and every section. */
export function systemText(context) {
  return context.messages.filter((m) => m.role === "system").map((m) => [
    typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""),
    ...Object.values(m.sections ?? {}).filter((v) => typeof v === "string"),
  ].join("\n")).join("\n");
}

export const sectionOf = (context) => /<learned>\n([\s\S]*?)\n<\/learned>/.exec(systemText(context))?.[1];

/** One run's store and Harness on SQLite, with the learn extension and a faux model scripted by `steps`. */
export async function openRun(storePath, { steps = [], extension = agentLearn(), extensions = [] } = {}) {
  await mkdir(path.dirname(storePath), { recursive: true });
  const database = await openNodeSqliteDatabase(storePath);
  await database.exec("PRAGMA synchronous = FULL");
  const storage = await SqliteStorage.open(database);
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses(steps);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);
  for (const e of extensions) registry.install(e);
  const harness = await Harness.open(storage, { models, registry }, ctx);
  return { harness, faux, close: () => harness.close(ctx) };
}

export const AGENT = { model: { provider: "faux", modelId: "faux-1" }, instructions: "Answer the question." };

/** Submits one input to the root conversation and waits for it to settle. */
export async function ask(harness, content = "What does the filing say?") {
  const root = await harness.root(ctx, { agent: AGENT });
  return (await root.submit({ type: "input", content }, ctx)).wait(ctx);
}

/** What each tool result showed the model. */
export const toolResults = (context) => context.messages.filter((m) => m.role === "toolResult").map((m) => ({ isError: m.isError === true, text: (m.content ?? []).map((c) => c.text ?? "").join("") }));

export const learnCalls = (calls) => fauxAssistantMessage(calls.map((args, i) => fauxToolCall("learn", args, { id: `call-${i}` })), { stopReason: "toolUse" });
export const done = () => fauxAssistantMessage([fauxText("Done.")], { stopReason: "stop" });

/** Records a seed that gave the run `ids` in its section and `omitted` over the cap, as seedLearning would. */
export async function seedIds(harness, ids, omitted = []) {
  await harness.commit(async (tx) => {
    Object.assign(await tx.doc(SeedDoc), { sha: SHA, index: ids.map((id) => `- ${id} lesson: A lesson.`), omitted, workflows: [], copied: false });
  }, ctx);
}
