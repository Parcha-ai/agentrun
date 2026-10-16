import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createGitRemoteExtension } from "../../dist/coding-agent.js";
import { local } from "../../dist/index.js";
import { rawGit, scratch } from "../support.mjs";

const FAUX_KEY = "not-a-key"; // a fake value, named so the source export's credential scan reads it as one

export const done = (text = "done") => fauxAssistantMessage(text);
export const turn = (...calls) => fauxAssistantMessage(calls.map(([name, args], i) => fauxToolCall(name, args ?? {}, { id: `call-${name}-${i}` })), { stopReason: "toolUse" });

/** A plain repository holding `files` (a string, or `{ link }` for a symlink), pushed to a new bare remote's main. */
export async function remoteWith(root, files) {
  const bare = path.join(root, "remote.git");
  await rawGit(["init", "-q", "--bare", "--template=", "-b", "main", bare]);
  const work = path.join(root, "seed-work");
  await rawGit(["init", "-q", "-b", "main", work]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(work, file)), { recursive: true });
    if (typeof content === "string") await writeFile(path.join(work, file), content);
    else await symlink(content.link, path.join(work, file));
  }
  await rawGit(["add", "-A"], { cwd: work });
  await rawGit(["commit", "-q", "-m", "seed"], { cwd: work });
  await rawGit(["push", "-q", bare, "main"], { cwd: work });
  return { bare, remote: local(bare), main: (await rawGit(["rev-parse", "main"], { gitDir: bare })).toString().trim() };
}

export const branchesOf = async (bare) => (await rawGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { gitDir: bare })).toString().split("\n").filter(Boolean).sort();
export const showOn = async (bare, ref, file) => (await rawGit(["show", `${ref}:${file}`], { gitDir: bare }).catch(() => null))?.toString() ?? null;
export const treeOf = async (bare, ref) => (await rawGit(["ls-tree", "-r", "--name-only", ref], { gitDir: bare })).toString().split("\n").filter(Boolean);
export const commitsOf = async (bare, ref, base) => (await rawGit(["rev-list", `${base}..${ref}`], { gitDir: bare })).toString().split("\n").filter(Boolean);
export const messageOf = async (bare, ref) => (await rawGit(["log", "-1", "--format=%B", ref], { gitDir: bare })).toString();

/**
 * A real pi session runtime with a fake model, the extension loaded as an extension factory. `options` go to
 * `createGitRemoteExtension`, `flags` to pi's flag values, `settings` into the agent directory's settings.json.
 */
export async function startSession(t, { options = {}, flags = {}, settings, root: given, work: givenWork, sessionFile } = {}) {
  const root = given ?? await scratch();
  const work = givenWork ?? path.join(root, "work");
  const agentDir = path.join(root, "agent");
  await mkdir(work, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  if (settings) await writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  const core = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "faux-1", input: ["text"] }] });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("faux", {
    api: "faux-api", apiKey: FAUX_KEY, baseUrl: "http://127.0.0.1:9", streamSimple: core.streamSimple,
    models: core.models.map((m) => ({ id: m.id, name: m.id, reasoning: false, input: m.input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 })),
  });
  const reports = [];
  const sessionManager = sessionFile ? SessionManager.open(sessionFile, path.join(root, "sessions"), work) : SessionManager.create(work, path.join(root, "sessions"));
  const createRuntime = async ({ cwd, sessionManager: manager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd, agentDir, modelRuntime, extensionFlagValues: new Map(Object.entries(flags)),
      resourceLoaderOptions: { extensionFactories: [createGitRemoteExtension({ stateDir: path.join(root, "state"), ...options, onEnd: (report) => { reports.push(report); options.onEnd?.(report); } })], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    return { ...(await createAgentSessionFromServices({ services, sessionManager: manager, sessionStartEvent, model: modelRuntime.getModel("faux", "faux-1") })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: work, agentDir, sessionManager });
  const errors = [];
  await runtime.session.bindExtensions({ onError: (error) => errors.push(error) });
  let disposed = false;
  t.after(async () => { if (!disposed) await runtime.dispose().catch(() => undefined); });
  const prompts = [];
  const system = (context) => (typeof context.systemPrompt === "string" ? context.systemPrompt : JSON.stringify(context.systemPrompt ?? ""));
  return {
    runtime, work, root, reports, errors, prompts, core,
    state: path.join(root, "state"),
    get session() { return runtime.session; },
    sessionId: () => runtime.session.sessionManager.getSessionId(),
    sessionFile: () => runtime.session.sessionManager.getSessionFile(),
    /** Runs the fake model through `turns` (messages) and returns the system prompts it was shown. */
    async run(...turns) {
      const before = prompts.length;
      core.setResponses([...turns.map((message) => (context) => { prompts.push(system(context)); return message; }), (context) => { prompts.push(system(context)); return done(); }]);
      await runtime.session.prompt("go");
      return prompts.slice(before);
    },
    async end() {
      disposed = true;
      await runtime.dispose();
    },
  };
}

export const read = (file) => readFile(file, "utf8");
