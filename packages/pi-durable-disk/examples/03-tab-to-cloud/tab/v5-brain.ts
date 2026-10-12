// The small model that runs the robot in a page (D1's robot fine-tune of Qwen3.5-0.8B, v5), as ONE implementation for both pages that carry it: the phone (pi on a
// phone, ?phone=1) and the laptop's "Take it offline" (the same session checked out to the browser). A host says where status, reports and the conversation go;
// everything else is here: which wllama build runs, the load, D1's serving file, the model's view of the tools, the T7 window with the robot's state line, the
// do-lock, the warm state, and the order those are set in. Prefetching the model while online is `PhoneModel.prefetch`. Portable: no Node API.
import type { AgentChange, Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { wllamaLlm, wllamaWith, partReads, partTimes } from "../../04-walks-home/tab/src/llm.ts";
import type { Llm, ToolChatMessage, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";
import { BRAIN_PROVIDER, brainModel, brainProvider, DEFAULT_TOOL_DECODING } from "./brain-provider.ts";
import { robotLock, signatureTools, signatureView, servingView, toNativeTools } from "./native-turn.ts";
import { buildOrder, PhoneModel, phoneWindow, served, turnReport, type WllamaBuild } from "./phone-model.ts";
import type { TabRuntime } from "./runtime.ts";
import { codeStateLine, stateLine } from "../robot-state-line.ts";
import { currentRobot, defaultSkill, loadSkills } from "../robot-tools.ts";
import { loadCodeBody } from "../robot-tools.ts";

export const V5_MODEL_ID = "robot-qwen35-0.8b-v5";
export const V5_MODEL_PATH = "/models/qwen35-0.8b-robot-v5-Q4_0-00001-of-00007.gguf";
export const V5_SERVING_PATH = "/models/qwen35-0.8b-robot-v5t-Q4_0.serving.json"; // V5T: v5's weights on the 16-tag prompt (D1), within a point of v5 on presets, the one config for preset and code bodies
export const V5_STATE_PATH = "/models/qwen35-0.8b-robot-v5t-Q4_0.state.bin"; // the warm state of the V5T prefix (595 tokens, batch 128)

/** Where the model's files are (same origin): the page's address overrides them (?model=, ?serving=, ?state=; ?state=0: no warm state). */
export function v5Urls(params: URLSearchParams, o: { modelUrl?: string; servingUrl?: string; stateUrl?: string | null } = {}): { modelUrl: string; servingUrl: string; stateUrl: string | undefined } {
  const abs = (path: string) => new URL(path, location.href).href;
  return {
    modelUrl: abs(o.modelUrl ?? params.get("model") ?? V5_MODEL_PATH),
    servingUrl: abs(o.servingUrl ?? params.get("serving") ?? V5_SERVING_PATH),
    stateUrl: o.stateUrl === null || params.get("state") === "0" ? undefined : abs(o.stateUrl ?? params.get("state") ?? V5_STATE_PATH),
  };
}

/** The model's small files an offline reload needs from the service worker's cache: its parts manifest, its serving file, its warm state's sidecar. (The parts and the state itself are in wllama's own cache.) */
export function v5SmallFiles(u: { modelUrl: string; servingUrl: string; stateUrl: string | undefined }): string[] {
  return [new URL(u.modelUrl).pathname.replace(/-00001-of-\d{5}\.gguf$/, ".parts.json"), new URL(u.servingUrl).pathname, ...(u.stateUrl ? [`${new URL(u.stateUrl).pathname}.json`] : [])];
}

/** How the model is served, as its trainer scored it (D1's <model>-serving.json, next to the model): its system prompt, its token budget, and its tools (v3) or none (v5: a signature prefix). */
export interface Serving { model: { file: string; sha256: string }; system: string; tools?: ToolChatTool[]; sampling?: { max_tokens?: number } }

/** What the page reads of the robot before a turn: the state line the window shows, the skills home, and on a body written as code its tags. */
export interface RobotRead { line: string | undefined; skills: string[]; tags?: string[] }

/** The robot as the state line the window shows before the user's turn, and the skills that came home (what the do-lock narrows to). */
export async function robotStateLine(env: unknown, context: unknown = ctx): Promise<RobotRead> {
  const e = env as never, c = context as never;
  const robot = await currentRobot(e, c);
  const skills = Object.keys(await loadSkills(e, c));
  if ("problem" in robot) return { line: undefined, skills };
  const doing = await defaultSkill(e, c); // what the pane plays: the manifest's default, its first skill, or walk
  const body = await loadCodeBody(e, c);
  // a body written as code has its own line (D1's v6 format): its tags and their colours, no shapes
  if (body) return { tags: [...body.tags], line: codeStateLine({ name: robot.name, face: robot.look.face, ...(robot.skill ? { skill: robot.skill } : {}) }, { body: body.name, tags: body.tags, pieceTags: body.pieceTags ?? {}, pieceColors: body.pieceColors ?? {}, legs: body.legs }, robot.look.tags ?? {}, skills, doing), skills };
  return { line: stateLine(robot, skills, doing), skills };
}

/** What a page tells the shared brain, and what it is told. */
export interface V5Host {
  params: URLSearchParams;
  /** The phase the brain is in, shown where the user types; with a line, kept in the log. */
  say(phase: string, line?: string): void;
  /** A line for the log only. */
  log(line: string): void;
  /** What was measured, sent to wherever this page reports. */
  report(kind: string, data: Record<string, unknown>): void;
  /** The conversation the brain is put on: the one the page follows now. */
  conversation(): Conversation;
  /** Marks (load, warm times) for the page's own report. */
  marks: Record<string, number>;
  /** The page's own robot state-line reader (default: `robotStateLine` over the runtime's environment). */
  stateLine?: (runtime: TabRuntime) => Promise<RobotRead>;
  /** Put wllama's build-selection patches of this page's wasm globals back once the model is loaded: a page that runs other wasm (the laptop's computer) needs them. */
  restoreWasmGlobals?: boolean;
  /** Where the model's files are, same origin (defaults: the v5 files under /models/; ?model=, ?serving=, ?state= override). */
  modelUrl?: string;
  servingUrl?: string;
  /** The warm state's URL; null: none (prefill). */
  stateUrl?: string | null;
  /** The model's id on the brain provider. */
  modelId?: string;
  /** The model backend of a build (default: wllama); a test hands in a stand-in. */
  makeLlm?: (build: WllamaBuild, logger: { debug(...a: unknown[]): void; log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }) => Llm;
}

export interface V5Brain {
  model: PhoneModel;
  serving: Serving;
  /** The conversation's agent on this brain: its tools in the system text's order, the serving file's system text as instructions. */
  agent: AgentChange;
  modelUrl: string;
  servingUrl: string;
  stateUrl: string | undefined;
  /** The skills home as the last state line read them. */
  skillsHome(): readonly string[];
  /** A fresh conversation on the same brain and tools (the earlier ones stay in the store). */
  newConversation(): Promise<Conversation>;
  /** Everything a reload needs from the network, for the offline cache: the paths of the model's small files. */
  smallFiles(): string[];
  /** What the brain loaded as: the wllama build. */
  build: WllamaBuild;
}

/**
 * Load the model, make it the conversation's brain with the tools it was trained on, read the system prompt and the tools once (a shipped warm state is restored
 * instead), and only then let anything run on it: the hooks every turn uses are set before `ready` is told and before a turn a reload cut short resumes.
 * `ready` runs once the brain can answer, and is given it; the call that resumes such a turn comes after it (it needs the provider, the lock and the reports in place).
 */
export async function startV5Brain(runtime: TabRuntime, host: V5Host, ready: (brain: V5Brain) => void | Promise<void> = () => undefined): Promise<V5Brain> {
  const params = host.params;
  const marks = host.marks;
  const modelId = host.modelId ?? V5_MODEL_ID;
  const engineLog = (level: string) => (...a: unknown[]) => { const line = a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "); if (level !== "debug" || /buffer size|error|failed/i.test(line)) host.log(`${(performance.now() / 1000).toFixed(1)} s ${level} ${line.slice(0, 300)}`); };
  // Which wllama build, in order of preference (buildOrder in phone-model.ts); the next is tried when one does not load (the watchdog, below):
  //   jspi32:   wasm32 + JSPI, no Asyncify (the shim's; Chrome, Safari 27): restores the warm state, half the size of the stock build.
  //   default:  wasm64 + JSPI (stock wllama; not on WebKit): prefills the system turn, since it has no slot restore.
  //   asyncify: wasm32 + Asyncify (the shim's compat build; every browser, Safari up to 26).
  // A build is chosen by what wllama is shown: memory64 hidden takes it to its compat path, JSPI hidden as well takes the compat path to Asyncify.
  // ?build=default|jspi32|asyncify tries only that one; ?compat=1 (Safari 26), ?mem64=0 and ?jspi32=0 as before; ?stall=<build> makes that build time out at once (a check).
  const ua = navigator.userAgent;
  const webkit = /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua); // every iPhone browser (CriOS included), desktop Safari
  const hasJSPI = "Suspending" in WebAssembly && params.get("compat") !== "1";
  const jspi32Served = await served("/vendor/wllama-jspi32/wllama.wasm"); // a GET: the 03 server answers HEAD with 405 and the offline worker only serves GETs
  const builds = buildOrder({ webkit, jspi: hasJSPI, jspi32Served: jspi32Served && params.get("jspi32") !== "0", noMemory64: params.get("mem64") === "0" || params.get("compat") === "1", only: (params.get("build") as WllamaBuild | null) ?? undefined });
  const loadTimeoutMs = (Number(params.get("loadtimeout")) || 90) * 1000;
  const RealMemory = WebAssembly.Memory, RealSuspending = (WebAssembly as { Suspending?: unknown }).Suspending;
  const show = (build: WllamaBuild) => {
    const NoMem64 = function Memory(desc: WebAssembly.MemoryDescriptor & { address?: string }) { if (desc?.address === "i64") throw new TypeError("memory64 is hidden: wllama's compat path"); return new RealMemory(desc); } as unknown as typeof WebAssembly.Memory;
    NoMem64.prototype = RealMemory.prototype;
    (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = build === "default" ? RealMemory : NoMem64;
    if (build === "asyncify") Reflect.deleteProperty(WebAssembly, "Suspending");
    else if (RealSuspending !== undefined) (WebAssembly as { Suspending?: unknown }).Suspending = RealSuspending;
  };
  const putBack = () => {
    (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = RealMemory;
    if (RealSuspending !== undefined) (WebAssembly as { Suspending?: unknown }).Suspending = RealSuspending;
  };
  const { modelUrl, servingUrl, stateUrl } = v5Urls(params, host);
  const makeModel = (build: WllamaBuild) => {
    const dir = build === "jspi32" ? "/vendor/wllama-jspi32" : "/vendor/wllama-compat";
    const logger = { debug: engineLog("debug"), log: engineLog("log"), warn: engineLog("warn"), error: engineLog("error") };
    const llm = host.makeLlm ? host.makeLlm(build, logger) : wllamaLlm(new URL("/vendor/wllama.wasm", location.origin).href, wllamaWith({ compat: { worker: new URL(`${dir}/wllama.js`, location.origin).href, wasm: new URL(`${dir}/wllama.wasm`, location.origin).href }, logger }));
    const model = new PhoneModel(llm, {
      url: modelUrl,
      threads: Number(params.get("threads")) || Math.min(4, navigator.hardwareConcurrency || 4),
      nCtx: Number(params.get("ctx")) || 2048,
      batch: Number(params.get("batch")) || 128, // n_batch = n_ubatch: a turn's tail (state line and user, under 128 tokens) is one batch, so its checkpoint sits where the next turn leaves it (PhoneModel.resume); the shipped state was made at 128
      maxTokens: 300,
      loadTimeoutMs: params.get("stall") === build ? 1 : loadTimeoutMs,
      onProgress: (loaded, total) => host.say(loaded < total ? `the robot's brain is downloading: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB` : `the robot's brain is loading into memory (${build} build)`),
      onStatus: (text) => host.say(`the robot's brain: ${text}`, text),
    });
    return { llm, model };
  };
  host.log(`engine: ${webkit ? "WebKit" : "not WebKit"}, JSPI ${hasJSPI ? "yes" : "no"}; builds to try: ${builds.join(", ")}`);
  let { llm, model } = makeModel(builds[0]!);
  // each step names itself in an error, so a page that fails says where
  const step = async <T,>(label: string, work: () => Promise<T>): Promise<T> => { try { return await work(); } catch (e) { throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`); } };
  // ?clearcache=1: forget the cached model files first (they are fetched and checked again), once: the switch is taken off the address
  if (params.get("clearcache") === "1") {
    await step("clearing the model cache", () => llm.clearCache?.() ?? Promise.resolve());
    host.log("model cache cleared");
    const u = new URL(location.href); u.searchParams.delete("clearcache"); history.replaceState(null, "", u);
  }
  const serving = await step("reading the model's serving file", async () => { const r = await fetch(servingUrl); if (!r.ok) throw new Error(`${servingUrl}: HTTP ${r.status}`); return (await r.json()) as Serving; });
  const signature = !serving.tools?.length; // v5: the system text lists the tools; nothing renders a tools block
  const toolNames = signature ? signatureTools(serving.system) : serving.tools!.map((t) => t.function.name);
  // the model's view: the serving file's tools (or, for a signature prefix, the conversation's tools it names), in its order, those the conversation offers
  const refine = (list: ToolChatTool[]) => (signature ? signatureView(list, toolNames) : servingView(list, serving.tools));
  const budget = serving.sampling?.max_tokens ?? 300;
  let t = performance.now();
  host.say("the robot's brain is loading");
  let build = builds[0]!;
  try {
    for (const [i, b] of builds.entries()) {
      if (i > 0) ({ llm, model } = makeModel(b));
      build = b;
      show(b);
      try {
        await step(`loading the model (${b} build)`, () => model.load());
        host.log(`engine: the ${b} build loaded`);
        host.report("build", { build: b, tried: builds.slice(0, i + 1) });
        break;
      } catch (e) {
        await llm.exit().catch(() => undefined);
        if (i === builds.length - 1) throw e;
        host.log(`${(e as Error).message}: trying the ${builds[i + 1]} build`);
        host.report("build-failed", { build: b, error: (e as Error).message.slice(0, 300) });
      }
    }
  } finally {
    if (host.restoreWasmGlobals) putBack(); // wllama's worker has its own globals: this page's wasm (the computer's) is left as it was
  }
  host.log(`model read in ${partReads.count} reads, the largest ${(partReads.largest / 1e6).toFixed(1)} MB`);
  marks.loadMs = Math.round(performance.now() - t);
  // where the load's time went: fetching parts, checking them, the engine reading them in
  Object.assign(marks, { downloadMs: Math.round(partTimes.downloadMs), downloadedMB: Math.round(partTimes.downloaded / 1e6), verifyMs: Math.round(partTimes.verifyMs), engineMs: Math.round(marks.loadMs - partTimes.downloadMs - partTimes.verifyMs) });
  host.log(`load ${(marks.loadMs / 1000).toFixed(1)} s: download ${(marks.downloadMs! / 1000).toFixed(1)} s (${marks.downloadedMB} MB), check ${(marks.verifyMs! / 1000).toFixed(1)} s, engine ${(marks.engineMs! / 1000).toFixed(1)} s`);
  // the robot's state, read before every turn: its line, and the skills home the lock narrows `do` to
  let skillsHome: string[] = [];
  let bodyTags: string[] | undefined;
  const readState = host.stateLine ?? ((rt: TabRuntime) => robotStateLine(rt.env));
  const refresh = async () => { const r = await readState(runtime); skillsHome = r.skills; bodyTags = r.tags; return r.line; };
  runtime.models.setProvider(brainProvider(model, brainModel(modelId, "Qwen3.5-0.8B robot v5 (D1's fine-tune)", Number(params.get("ctx")) || 2048, 200), {
    ...DEFAULT_TOOL_DECODING, mode: "native", callTokens: Math.ceil((budget * 2) / 3), answerTokens: Math.floor(budget / 3), system: serving.system, refine, closing: params.get("closing") === "model" ? "model" : "tool-result",
    // D1's window T7: the earlier exchanges, the robot's state line, then the user's turn; ?window=task: the current task only (the model forgets earlier turns)
    ...phoneWindow(params.get("window") === "task", { refresh, fits: (m: ToolChatMessage[], tl: ToolChatTool[]) => model.fits(m, tl) }),
  }));
  const byName = new Map(runtime.registry.snapshot().tools().map((r) => [r.tool.name, r.tool]));
  const tools = toolNames.map((n) => byName.get(n)).filter((r): r is NonNullable<typeof r> => r !== undefined); // in the serving file's order
  const agent: AgentChange = { model: { provider: BRAIN_PROVIDER, modelId }, thinkingLevel: "off" as const, tools, instructions: serving.system };
  const conversation = host.conversation();
  const now = await conversation.agent(ctx);
  if (!(now.model?.provider === BRAIN_PROVIDER && now.model.modelId === modelId)) await conversation.configure(agent, ctx);
  t = performance.now();
  host.say("the robot's brain is reading its tools (once)");
  // the tools exactly as the provider sends them (native-turn.ts), so the prefix is the turns' prefix; a shipped warm state for it is restored instead (?state=0: prefill)
  // BEFORE the warm-up: it renders the prefix and checks its sha against the state's sidecar, and a prefix with a tools block (or the window off) is another prefix: the state is skipped and the 1,252 tokens prefilled (about 200 s)
  model.toolsInPrompt = !signature;
  model.stemFirst = params.get("stem") !== "0"; // the exchanges-first read (?stem=0: the warm state restored before every turn instead)
  const warm = await step("reading the tools", () => model.warm(serving.system, refine(toNativeTools(tools)), stateUrl ? { url: stateUrl, onSkip: (why) => host.log(`no warm state restored: ${why}`) } : undefined));
  if (warm.restored) host.log(`warm state restored: ${warm.restored.tokens} tokens, ${Math.round(warm.restored.bytes / 1e6)} MB in ${warm.ms} ms`);
  marks.warmMs = Math.round(performance.now() - t);
  marks.warmTokens = warm.promptTokens;
  // everything a turn uses is in place before anything can run on the brain: a turn a reload cut short resumes below, and runs locked and reported
  model.lock = (shown) => robotLock(shown, { system: serving.system, home: skillsHome, ...(bodyTags ? { tags: bodyTags } : {}) }); // native-turn.ts: the prompt's own values, then the body's tags and the skills home
  model.onTurn = (turn) => host.report("turn", turnReport(turn, params.get("report") === "text")); // the reply's words only when the page was opened to send them
  model.onTurnStart = () => host.report("turn-start", {});
  host.say("", `brain ready: loaded in ${(marks.loadMs / 1000).toFixed(1)} s, tools read in ${(marks.warmMs / 1000).toFixed(1)} s (${warm.promptTokens} tokens)`);
  host.report("ready", { ...marks, restored: warm.restored ? warm.restored.tokens : 0, build, threads: Number(params.get("threads")) || Math.min(4, navigator.hardwareConcurrency || 4), reads: partReads.count, largestRead: partReads.largest });
  const result: V5Brain = {
    model, serving, agent, modelUrl, servingUrl, stateUrl, build,
    skillsHome: () => skillsHome,
    async newConversation() {
      const fresh = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: BRAIN_PROVIDER, modelId }, thinkingLevel: "off", instructions: serving.system } }, ctx);
      await fresh.configure(agent, ctx);
      return fresh;
    },
    smallFiles: () => v5SmallFiles({ modelUrl, servingUrl, stateUrl }),
  };
  await ready(result);
  // what a reload cut short (a turn in the middle of its model call or its tools) runs now, on the brain that just came up
  await runtime.harness.resume();
  return result;
}
