import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createBrowserExtension } from "../../dist/coding-agent.js";
const FAUX_KEY = "not-a-key"; // a fake value, named so the source export's credential scan reads it as one

const faux = () => createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "faux-1", input: ["text", "image"] }] });

export const turn = (...calls) => fauxAssistantMessage(calls.map(([name, args], i) => fauxToolCall(name, args ?? {}, { id: `call-${name}-${i}-${Math.random().toString(36).slice(2, 6)}` })), { stopReason: "toolUse" });
export const done = (text = "done") => fauxAssistantMessage(text);

const users = new Map();

export async function startAgent(t, { extension = {}, sessionFile = null, cwd = null, flags = {}, dir = null } = {}) {
  const root = dir ?? await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "pi-agent-rig-"));
  users.set(root, (users.get(root) ?? 0) + 1);
  const release = () => {
    users.set(root, users.get(root) - 1);
    if (users.get(root) === 0) { users.delete(root); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  };
  try {
    return await start();
  } catch (error) {
    release();
    throw error;
  }

  async function start() {
    const work = cwd ?? path.join(root, "work");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(work, { recursive: true });
    const core = faux();
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerProvider("faux", {
      api: "faux-api", apiKey: FAUX_KEY, baseUrl: "http://127.0.0.1:9", streamSimple: core.streamSimple,
      models: core.models.map((m) => ({ id: m.id, name: m.id, reasoning: false, input: m.input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 })),
    });
    const sessionManager = sessionFile ? SessionManager.open(sessionFile, path.join(root, "sessions"), work) : SessionManager.create(work, path.join(root, "sessions"));
    const createRuntime = async ({ cwd: runtimeCwd, sessionManager: manager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: runtimeCwd, agentDir, modelRuntime, extensionFlagValues: new Map(Object.entries(flags)),
        resourceLoaderOptions: { extensionFactories: [createBrowserExtension({ env: {}, ...extension })], noExtensions: true },
      });
      return { ...(await createAgentSessionFromServices({ services, sessionManager: manager, sessionStartEvent, model: modelRuntime.getModel("faux", "faux-1"), noTools: "builtin" })), services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, { cwd: work, agentDir, sessionManager });
    const seen = [];
    const prompts = [];
    let stop = null;
    const bind = async () => {
      stop?.();
      await runtime.session.bindExtensions({});
      stop = runtime.session.subscribe((event) => {
        if (event.type === "tool_execution_end") {
          const text = (event.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
          seen.push({ tool: event.toolName, isError: event.isError === true, text, result: event.result });
        }
      });
    };
    await bind();
    let disposed = false;
    // A runtime whose tool call the fake provider holds forever (a killed process) cannot finish disposing: bound the
    // wait.
    t.after(async () => {
      stop?.();
      if (!disposed) await Promise.race([runtime.dispose().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      release();
    });
    return {
      runtime, work, root, seen, prompts, core,
      get session() { return runtime.session; },
      sessionFile: () => runtime.session.sessionManager.getSessionFile(),
      entries: () => runtime.session.sessionManager.getBranch(),
      custom: (type) => runtime.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === type).map((e) => e.data),
      async run(...turns) {
        const before = seen.length;
        core.setResponses([...turns.map((message) => (context) => { prompts.push(context); return typeof message === "function" ? message(context) : message; }), (context) => { prompts.push(context); return done(); }]);
        await runtime.session.prompt("go");
        return seen.slice(before);
      },
      bind,
      async dispose() { disposed = true; stop?.(); await runtime.dispose(); },
    };
  }
}
