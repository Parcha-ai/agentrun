// A pi process as a person runs it after `pi install`: the settings in the scratch agent directory name the package, pi's
// own loader finds its manifest, and the agent's tools are the package's. Prints one JSON line.
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const [work, agentDir] = process.argv.slice(2);
const core = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "faux-1", input: ["text"] }] });
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerProvider("faux", { api: "faux-api", apiKey: "x", baseUrl: "http://127.0.0.1:9", streamSimple: core.streamSimple,
  models: [{ id: "faux-1", name: "faux-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
const services = await createAgentSessionServices({ cwd: work, agentDir, modelRuntime });
const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model: modelRuntime.getModel("faux", "faux-1"), noTools: "builtin" });
await session.bindExtensions({});
const results = [];
session.subscribe((event) => { if (event.type === "tool_execution_end") results.push({ tool: event.toolName, isError: event.isError === true, text: (event.result?.content ?? []).map((c) => c.text ?? "").join("") }); });
core.setResponses([fauxAssistantMessage([fauxToolCall("browser_release", {}, { id: "r1" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
await session.prompt("release");
const tools = session.getAllTools().map((t) => t.name).sort();
const errors = services.diagnostics?.map?.((d) => `${d.type ?? "diagnostic"}: ${d.message ?? ""}`) ?? [];
console.log(JSON.stringify({ tools, results, errors }));
session.dispose();
