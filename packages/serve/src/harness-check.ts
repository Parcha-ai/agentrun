// `agentrun harness-check --recipe FILE`: a recipe's agent run for real, the way serve would run it, and judged. It loads
// the recipe (harness-recipe.ts: the five rules, each refused by its code), finds the binary its owner installed and
// checks its pin, then drives the ACP adapter over four turns of a live session on the run's model, and writes what it
// saw as a JSON report:
//   Stage 2, the real binary: its tools are off (the first model request offers only ours), its environment is the
//     allowlist (read from /proc on Linux), its pin holds at every start, its billing limits hold (proxy: a request past
//     the cap is refused unsent; plan: the adapter's turn and call limits are set), and it makes no side request (the
//     provider sees only the turns' Messages requests; anything it reaches for beyond loopback goes to the check's own
//     proxy, which refuses and lists it).
//   Stage 3, live: the agent is killed (SIGKILL) after a turn and the next turn resumes it (its own session/load, or a
//     fresh session told the conversation), a denied call never runs, one of our tools runs over MCP, and another runner
//     with its own directory picks the session up from the records.
// It prints the three facts a harness row carries: resume (load | restart), tool_gate (permission | config: whether the
// agent asks before a tool call) and billing (proxy | plan).
// The check spends: four short turns on the run's model, under a cap (default $0.25).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HostTool, SessionRecord, SessionStore } from "@parcha/agentrun-kernel";
import { modelPortFor, SessionFenced } from "@parcha/agentrun-kernel";
import { beforeRequestOf } from "@parcha/agentrun-kernel/kernel/cap";
import type { AdapterNeeds } from "./adapters.js";
import { archivePlatform } from "./harness-archive.js";
import { egressProxy, egressVars } from "./harness-egress.js";
import { AGENT_VARS, installHolds, loadRecipe, recipeInstall, RecipeRefused, writeChecked } from "./harness-recipe.js";
import { recipeEntryOf } from "./harness-recipe-entry.js";
import { providerModels } from "./model.js";
import { capModelOf } from "./runner/cli-run-spec.js";
import { keyShaped } from "./secret-name.js";
import { secretRedactor } from "./runner/redact.js";
import { hostSecrets, SECRET_NAMES } from "./secrets.js";

/** What a shell sets for itself when the binary is a script (its working directory, its depth): never the host's. */
const SHELL_OWN = ["PWD", "OLDPWD", "SHLVL", "_"];

export const CHECK_DEFAULT_CAP_USD = 0.25;
const TURN_MS = 240_000;

export interface HarnessCheckOptions {
  /** The recipe file. */
  recipe: string;
  /** The data directory its owner installed it into. */
  data: string;
  /** The run's model, `provider/model-id` (a proxy-billed recipe needs one). */
  model?: string;
  /** The process's environment with its secrets (withSecrets): the provider's key, the recipe's own keys. */
  env: NodeJS.ProcessEnv;
  /** The most the check may spend, USD. */
  capUsd?: number;
  platform?: string;
  /** For tests: the fetch the model proxy forwards with. */
  fetch?: typeof fetch;
  /** Each step as it happens, a line of words. */
  say?: (line: string) => void;
  turnMs?: number;
}

type Check = { ok: boolean | null; [field: string]: unknown };

export interface HarnessCheckReport {
  ok: boolean;
  recipe: { id: string; label: string; file: string; sha256: string } | { file: string };
  refused?: { code: string; message: string };
  platform?: string;
  model?: string;
  /** The installed binary, and the tree digest it and every file beside it were held to: the recipe's or the first one
   *  its install recorded. */
  binary?: { path: string; tree: string; pinnedBy: "recipe" | "first-seen" };
  stage2?: Record<string, Check>;
  stage3?: Record<string, Check>;
  facts?: { resume: "load" | "restart" | "unknown"; tool_gate: "permission" | "config"; billing: "proxy" | "plan" };
  gate?: { permissionsAsked: { toolCallId: unknown; kind: unknown }[]; asked: { tool: string; answer: string }[] };
  spendUsd?: number | null;
  checkedAt: string;
  failures: string[];
}

/** The check's session records, in memory for the check's life: one session, opened by each runner in turn. The newest
 *  open holds it; an older writer's append is fenced, as the server's store fences a runner whose claim was taken. */
function checkStore(): SessionStore {
  const records = new Map<string, SessionRecord[]>();
  const holders = new Map<string, number>();
  const read = async (key: string) => structuredClone(records.get(key) ?? []);
  return {
    read,
    async open(key) {
      const holder = (holders.get(key) ?? 0) + 1;
      holders.set(key, holder);
      return {
        key,
        read: () => read(key),
        async append(added) {
          if (holders.get(key) !== holder) throw new SessionFenced(key);
          records.set(key, [...(records.get(key) ?? []), ...structuredClone(added as SessionRecord[])]);
        },
        sync: async () => {},
      };
    },
  };
}

export { egressProxy };

/** A process's environment, by name, from /proc (Linux); undefined elsewhere or once it is gone. */
function environOf(pid: number): Record<string, string> | undefined {
  try {
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  } catch {
    return undefined;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kills the agent's process by its pid, once it is this process's own child running the recipe's binary (or what the
 *  binary exec'd, a script's interpreter): never another process. */
async function killAgent(pid: number, binary: string): Promise<boolean> {
  let cmdline = "";
  let parent: number | undefined;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    parent = Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1]);
  } catch {
    // Not Linux: ps says the command and the parent.
    const ps = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim() ?? "";
    parent = Number(ps.split(/\s+/)[0]);
    cmdline = ps.slice(ps.indexOf(" ") + 1);
  }
  if (!cmdline || (parent !== process.pid && !cmdline.includes(binary))) return false;
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

/** The text of a request body, whatever the proxy sent it as. */
function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "";
}

/** The model ref `provider/model-id`. */
function modelRef(ref: string): { provider: string; modelId: string } | undefined {
  const at = ref.indexOf("/");
  return at > 0 && at < ref.length - 1 ? { provider: ref.slice(0, at), modelId: ref.slice(at + 1) } : undefined;
}

/** The values of the keys `env` holds but those named in `except`, each read by name (withSecrets keeps the server's off
 *  its enumeration): SECRET_NAMES and every key-shaped name. */
const keyValues = (env: NodeJS.ProcessEnv, except: readonly string[] = []): string[] =>
  [...new Set([...SECRET_NAMES, ...Object.keys(env).filter((name) => keyShaped(name))])]
    .filter((name) => !except.includes(name))
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && value.length >= 8);

/** `value` with every string in it put through `cut`, its arrays and objects walked (their names are the check's own). */
const cutEvery = <T>(value: T, cut: (text: string) => string): T =>
  (typeof value === "string" ? cut(value)
    : Array.isArray(value) ? value.map((each) => cutEvery(each, cut))
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, each]) => [name, cutEvery(each, cut)]))
    : value) as T;

/** Runs the check. Never throws for what it judges: a refused recipe, a missing install or a failed stage is in the
 *  report (`ok: false`, `failures`). Every string of the report and every line it says has the server's secrets and the
 *  recipe's keys cut (runner/redact.ts secretRedactor), so an agent's words in it (a failed turn's stderr, a refusal, a
 *  log line) never carry a key out to the report's file or the terminal. */
export async function harnessCheck(options: HarnessCheckOptions): Promise<HarnessCheckReport> {
  // The values cut: the server's secrets, then the recipe's keys' values once it is loaded (checkRun adds them).
  const held = [...hostSecrets(options.env), ...keyValues(options.env)];
  const cut = () => secretRedactor(held);
  const report = await checkRun({ ...options, say: (line) => options.say?.(cut()(line)) }, held);
  return cutEvery(report, cut());
}

/** The check itself (harnessCheck), adding the values of the recipe's keys to `held` once it is loaded. */
async function checkRun(options: HarnessCheckOptions, held: string[]): Promise<HarnessCheckReport> {
  const say = options.say ?? (() => {});
  const checkedAt = new Date().toISOString();
  const failures: string[] = [];
  let loaded: ReturnType<typeof loadRecipe>;
  try {
    loaded = loadRecipe(options.recipe);
  } catch (error) {
    if (!(error instanceof RecipeRefused)) throw error;
    return { ok: false, recipe: { file: options.recipe }, refused: { code: error.code, message: error.message }, checkedAt, failures: [error.message] };
  }
  const { recipe } = loaded;
  // The recipe's keys, read by name from the check's environment: the agent holds them, so its words may too.
  held.push(...recipe.keys.map((name) => options.env[name]).filter((value): value is string => typeof value === "string"));
  const head = { recipe: { id: recipe.id, label: recipe.label, file: loaded.file, sha256: loaded.sha256 }, checkedAt } as const;
  const refuse = (code: string, message: string): HarnessCheckReport => ({ ok: false, ...head, refused: { code, message: `${code}: ${message}` }, failures: [`${code}: ${message}`] });
  say(`${recipe.label}: the recipe holds the five rules (${loaded.file})`);
  // What the agent runs on: the recipe's keys, read from this shell, alone (a proxy-billed one's: none, the model proxy's).
  // A check never runs on its owner's own sign-in, which a schedule, a check and a shared server never take
  // (HARNESS.md#sign-in): a plan-billed recipe whose key is not set here is refused before its agent starts.
  const route = { on: "keys" } as const;

  // Stage 2's pins: every file the owner's install put there, the binary among them, the recipe's treeSha256 or the tree
  // its install recorded (recipeInstall). Nothing is downloaded here; one installed before trees were recorded is
  // installed again, so nothing in it runs unpinned.
  const install = recipeInstall(options.data, recipe, loaded.file, options.env, options.platform ?? archivePlatform());
  if ("code" in install) return refuse(install.code, install.message);
  const { platform, release, binary } = install;
  const off = await installHolds(install);
  if (off) return refuse(off.code, off.message);
  say(`${recipe.label}: the binary and every file beside it are the pinned tree (${install.tree.by === "recipe" ? "the recipe's treeSha256" : "the tree its install recorded"})`);

  // The run's model, for a recipe billed through the proxy: named here; its key, the login refusal and its price are its
  // entry's (below), as a server's are.
  const env = options.env;
  let needs: AdapterNeeds | undefined;
  if (recipe.model.billing === "proxy") {
    const ref = options.model ? modelRef(options.model) : undefined;
    if (!ref) return refuse("HARNESS_CHECK_USAGE", `${recipe.label} is billed through the proxy: name the run's model with --model provider/model-id (openrouter/anthropic/claude-haiku-4.5, anthropic/claude-haiku-4-5)`);
    needs = { model: ref, models: await providerModels(env) };
  }

  // The session: the check's tools, its gate, its egress proxy, the recording fetch.
  const nonce = randomBytes(6).toString("hex");
  const echoed: unknown[] = [];
  const deniedRan: unknown[] = [];
  const tools: HostTool[] = [
    { name: "check_echo", description: "Echo the text back, prefixed with ECHO.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, replay: "never", call: async (args) => (echoed.push(args), { text: `ECHO:${(args as { text?: unknown })?.text ?? ""}` }) },
    { name: "check_denied", description: "A tool this run refuses: calling it shows the refusal.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, replay: "never", call: async (args) => (deniedRan.push(args), { text: "this call should never have run" }) },
  ];
  // The gate allows check_echo alone. Everything else is denied, the agent's own calls (`acp_<kind>`) included, as a
  // server's gate answers them: a call of ours whose title the adapter can't tie is one of those, so it fails mcp_tool.
  const gateAsked: { tool: string; answer: string }[] = [];
  const gate = async (call: { tool: string }) => {
    const answer = call.tool === "check_echo" ? "allow" : "deny";
    gateAsked.push({ tool: call.tool, answer });
    return answer === "allow" ? ("allow" as const) : { deny: "harness-check refuses this call on purpose" };
  };
  const forwarded: { method: string; path: string; tools: string[]; text: string }[] = [];
  const forward = options.fetch ?? fetch;
  const recording: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const text = bodyText(init?.body);
    let toolNames: string[] = [];
    try {
      const parsed = JSON.parse(text) as { tools?: { name?: unknown }[] };
      toolNames = (parsed.tools ?? []).map((tool) => String(tool.name));
    } catch {
      // Not JSON: no tools.
    }
    forwarded.push({ method: init?.method ?? "GET", path: url.pathname, tools: toolNames, text });
    return forward(input, init);
  };
  const logs: { message: string; [field: string]: unknown }[] = [];
  const log = (message: string, fields?: Record<string, unknown>) => void logs.push({ message, ...(fields ?? {}) });
  // A plan-billed agent reaches its vendor through the check's proxy, tunneled to the hosts its recipe names.
  const egress = await egressProxy(recipe.model.billing === "plan" ? (recipe.model.hosts ?? []) : []);
  const work = await mkdtemp(join(tmpdir(), "agentrun-harness-check-"));
  const canary = `harness-check-canary-${nonce}`;
  // The host's environment as the adapter reads it, by name, with the canary over it: built on `env` (its prototype), not
  // spread from it, so the keys withSecrets keeps off its enumeration still read by name. The recipe's keys reach the
  // agent from here alone (the adapter's recipe.keys, as a run's do): a host without one is refused before the start.
  const hostEnv: NodeJS.ProcessEnv = Object.create(env, { HARNESS_CHECK_CANARY: { value: canary, enumerable: true } });
  // The values of every key the host holds, the server's own included: withSecrets keeps those off its enumeration, so
  // each is read by name.
  const hostKeys = keyValues(env, recipe.keys);
  const childVars: Record<string, string> = { ...recipe.env, ...egressVars(egress.url) };
  // The run's model id reaches a proxy-billed agent under the variable its recipe names.
  const modelVar = recipe.model.billing === "proxy" ? recipe.model.env : undefined;
  // The plan's model, where the recipe names one: chosen among those the agent lists (session/set_model).
  const planModel = recipe.model.billing === "plan" ? recipe.model.id : undefined;
  // Each start of the agent's process checks the pin again (installHolds): a binary or a file beside it swapped after the
  // check began never runs. `starts`: the starts that held.
  let starts = 0;
  const beforeStart = async (command: string) => {
    const off = await installHolds(install);
    if (off) throw new Error(`${off.code}: ${command} or a file beside it changed after the check began: ${off.message}`);
    starts += 1;
  };
  // The recipe's entry as a server builds it (harness-recipe-entry.ts), on this check's route, log, variables (its egress
  // proxy) and recording fetch.
  const entry = recipeEntryOf({ recipe, binary, release, route: () => route, beforeStart, vars: () => childVars, fetch: recording, log });
  const planNeeds: AdapterNeeds = { model: { provider: recipe.id, modelId: planModel ?? "default" }, models: { getModel: () => undefined } };
  const adapterFor = async (): Promise<AgentAdapter> => entry.adapter!(hostEnv, needs ?? planNeeds);
  // The first runner's adapter is made before any turn, so a model this server can't run is refused before the agent
  // starts; with it, the cap's model, priced here or refused.
  let firstAdapter: AgentAdapter | undefined;
  let capModel: ReturnType<typeof capModelOf> | undefined;
  if (needs) {
    const refuseHere = async (message: string) => {
      await egress.close();
      await rm(work, { recursive: true, force: true }).catch(() => {});
      return refuse("HARNESS_CHECK_MODEL", message);
    };
    try {
      firstAdapter = await adapterFor();
    } catch (error) {
      return refuseHere((error as Error).message);
    }
    const priceModel = entry.priceModel(hostEnv, needs.model);
    const listed = needs.models.getModel(priceModel.provider, priceModel.modelId) as { cost?: Record<string, number>; maxTokens?: number } | undefined;
    capModel = capModelOf(priceModel.modelId, "anthropic-messages", listed as never, listed === undefined);
    if (!capModel.price) return refuseHere(`${priceModel.provider}/${priceModel.modelId} has no price here, so the check's cap could not hold; name a priced model`);
  }
  let capUsd: number | undefined = options.capUsd ?? CHECK_DEFAULT_CAP_USD;
  const store = checkStore();
  const refusedRequests: { reason: string; code?: string; message?: string }[] = [];
  let lastBooking: Awaited<ReturnType<typeof modelPortFor>> | undefined;
  // A runner's session, in its own directory (the one a server lends, io.dir), on its own adapter.
  const sessionOn = async (dir: string) => {
    const adapter = firstAdapter ?? (await adapterFor());
    firstAdapter = undefined;
    const writer = await store.open("check");
    const booking = await modelPortFor(writer, {
      key: "check",
      ...(capModel ? { beforeRequest: beforeRequestOf({ capUsd: () => capUsd, modelOf: () => capModel! }) } : {}),
      stop: (reason, message, code) => (refusedRequests.push({ reason, ...(code ? { code } : {}), ...(message ? { message } : {}) }), new Error(`${code ?? reason}: ${message ?? ""}`)),
    });
    lastBooking = booking;
    const controller = new AbortController();
    const session = await adapter.open({ key: "check", label: "root", system: [], tools, context: "fresh" }, { writer, models: booking.models, signal: controller.signal, onEvent: () => {}, gate, dir } as never);
    const turn = async (text: string) => {
      const timer = setTimeout(() => controller.abort(new Error("the turn took too long")), options.turnMs ?? TURN_MS);
      try {
        await session.send(text);
        return await session.turnEnd();
      } finally {
        clearTimeout(timer);
      }
    };
    return { session, turn, booking };
  };
  const opened = () => logs.filter((l) => l.message === "acp: the agent's session is open") as unknown as { sessionId: string; loaded: boolean; pid: number }[];
  const asked = () => logs.filter((l) => l.message === "acp: the agent asked permission");
  const messages = () => forwarded.filter((r) => r.method === "POST" && r.path.endsWith("/v1/messages"));
  const stage2: Record<string, Check> = {};
  const stage3: Record<string, Check> = {};
  let resumeFact: "load" | "restart" | "unknown" = "unknown";

  try {
    // Turn 1: one of our tools over MCP.
    say(`${recipe.label}: turn 1, a call of our check_echo tool over MCP`);
    const first = await sessionOn(join(work, "runner-a"));
    const t1 = await first.turn(`Use the check_echo tool once, with the text argument set to ${nonce}. Then reply with exactly what it returned and nothing else.`);
    const firstOpen = opened()[0];
    // The environment while the agent runs.
    const environ = firstOpen?.pid ? environOf(firstOpen.pid) : undefined;
    const echoReached = messages().some((r) => r.text.includes(`ECHO:${nonce}`));
    stage3.mcp_tool = { ok: t1.status === "completed" && echoed.length >= 1 && (recipe.model.billing !== "proxy" || echoReached), turn: t1.status, ...(t1.error ? { error: t1.error } : {}), calls: echoed.length, resultReachedModel: recipe.model.billing === "proxy" ? echoReached : null };

    // Stage 2: the tools the agent offered its model on its first request. The proxy refuses a request that offers a tool
    // its policy does not allow, so one that reached the provider at all passed that rule: the stage is whether one did.
    // Its refusals are listed beside it, never counted: a port watcher's GET / is refused too.
    if (recipe.model.billing === "proxy") {
      const firstRequest = messages()[0];
      const ours = new Set(tools.map((tool) => `agentrun__${tool.name}`));
      const offered = firstRequest?.tools ?? [];
      const refusals = logs.filter((l) => /refus/i.test(l.message)).map((l) => ({ message: l.message, ...(typeof l.reason === "string" ? { reason: l.reason } : {}) }));
      stage2.tools_off = { ok: !!firstRequest, firstRequest: offered, notOurs: offered.filter((name) => !ours.has(name)), ...(refusals.length ? { proxyRefusals: refusals } : {}) };
    } else stage2.tools_off = { ok: null, why: "plan billing: the vendor's model requests never reach this host, so the tools it offers are not seen" };

    // Stage 2: the environment is the allowlist.
    if (environ) {
      // The recipe's keys too: the adapter hands each over under the name its agent reads (recipe.keyEnv, else its own),
      // never through childVars.
      const expected = new Set([...Object.values(AGENT_VARS).flat(), ...Object.keys(childVars), ...(modelVar ? [modelVar] : []), ...recipe.keys.map((name) => recipe.keyEnv[name] ?? name), ...SHELL_OWN]);
      const extra = Object.keys(environ).filter((name) => !expected.has(name)).sort();
      const leaked = Object.entries(environ).filter(([, value]) => hostKeys.includes(value) || value === canary).map(([name]) => name).sort();
      stage2.env_allowlist = { ok: extra.length === 0 && leaked.length === 0, names: Object.keys(environ).sort(), beyondAllowlist: extra, hostSecretsSeen: leaked };
    } else stage2.env_allowlist = { ok: null, why: process.platform === "linux" ? "the agent's process was gone before its environment was read" : "the environment is read from /proc, on Linux alone" };

    // Kill the agent, then turn 2: the denied call, and what turn 1 said.
    let killed = false;
    if (firstOpen?.pid) killed = await killAgent(firstOpen.pid, binary);
    say(`${recipe.label}: the agent is killed (SIGKILL, pid ${firstOpen?.pid ?? "unknown"}); turn 2, a denied call and the conversation so far`);
    const before = messages().length;
    const t2 = await first.turn(`Use the check_denied tool once, with the text argument set to two. It will be refused; that is expected. Then reply with the text the check_echo tool returned earlier in this conversation.`);
    const secondOpen = opened()[1];
    // What check_echo returned in turn 1 is in the model's next request: the conversation came through the kill.
    const remembered = messages().slice(before).some((r) => r.text.includes(`ECHO:${nonce}`));
    resumeFact = secondOpen ? (secondOpen.loaded ? "load" : "restart") : "unknown";
    stage3.resume = { ok: killed && t2.status === "completed" && !!secondOpen && secondOpen.pid !== firstOpen?.pid && (recipe.model.billing !== "proxy" || remembered), killed, turn: t2.status, ...(t2.error ? { error: t2.error } : {}), newProcess: !!secondOpen && secondOpen.pid !== firstOpen?.pid, loaded: secondOpen?.loaded ?? null, sameSession: !!secondOpen && secondOpen.sessionId === firstOpen?.sessionId, conversationCarried: recipe.model.billing === "proxy" ? remembered : null };
    const deniedAsked = gateAsked.filter((g) => g.tool === "check_denied");
    stage3.denied_call = { ok: deniedAsked.length >= 1 && deniedAsked.every((g) => g.answer === "deny") && deniedRan.length === 0 && t2.status === "completed", gateAsked: deniedAsked.length, ran: deniedRan.length, turn: t2.status };
    await first.session.close();

    // Turn 3: another runner, its own directory, from the records.
    say(`${recipe.label}: turn 3, another runner picks the session up from the records`);
    const other = await sessionOn(join(work, "runner-b"));
    const before3 = messages().length;
    const t3 = await other.turn("Reply with the word ready and nothing else.");
    const thirdOpen = opened().at(-1);
    const carried3 = messages().slice(before3).some((r) => r.text.includes(`ECHO:${nonce}`));
    stage3.other_runner = { ok: t3.status === "completed" && (recipe.model.billing !== "proxy" || carried3), turn: t3.status, ...(t3.error ? { error: t3.error } : {}), loaded: thirdOpen?.loaded ?? null, conversationCarried: recipe.model.billing === "proxy" ? carried3 : null };

    // Turn 4: the billing limit. Proxy: the cap is set at what was spent, so the next request is refused unsent.
    if (recipe.model.billing === "proxy") {
      const spent = other.booking.spentUsd();
      capUsd = spent ?? 0;
      const sentBefore = messages().length;
      const t4 = await other.turn("Reply with the word ok.");
      const unsent = messages().length === sentBefore;
      stage2.limits = { ok: t4.status !== "completed" && unsent && refusedRequests.some((r) => r.reason === "refused"), billing: "proxy", capUsd: capUsd, turn: t4.status, refusedUnsent: unsent, ...(refusedRequests.length ? { refusal: refusedRequests.at(-1) } : {}) };
    } else stage2.limits = { ok: true, billing: "plan", maxTurns: recipe.model.maxTurns, maxToolCalls: recipe.model.maxToolCalls, why: "the adapter stops the run at these; the vendor bills the owner's plan" };
    await other.session.close();

    // Stage 2: the pin held at every start; no side request.
    stage2.pins = { ok: starts > 0, binary, tree: install.tree.sha256, pinnedBy: install.tree.by, archiveSha256: release.sha256, starts };
    if (recipe.model.billing === "proxy") {
      const paths = [...new Set(forwarded.map((r) => `${r.method} ${r.path}`))];
      // What the agent asked the proxy for beyond the Messages route: refused there, never sent on.
      const atProxy = logs.filter((l) => /: refused$/.test(l.message) && typeof l.path === "string" && !String(l.path).startsWith("/v1/messages")).map((l) => `${String(l.method)} ${String(l.path)}`);
      // The provider's Messages route, under its own prefix (OpenRouter's is /api/v1/messages).
      stage2.side_requests = { ok: forwarded.every((r) => r.method === "POST" && r.path.endsWith("/v1/messages")), toProvider: paths, sent: forwarded.length, refusedAtProxy: atProxy, beyondLoopbackRefused: egress.asked.filter((a) => !a.tunneled).map((a) => `${a.method} ${a.target}`) };
    } else stage2.side_requests = { ok: null, toVendor: [...new Set(egress.asked.filter((a) => a.tunneled).map((a) => a.target))], beyondLoopbackRefused: egress.asked.filter((a) => !a.tunneled).map((a) => `${a.method} ${a.target}`), why: "plan billing: the vendor's requests are tunneled to model.hosts through the check's proxy, so their content is not seen here" };
  } catch (error) {
    failures.push(`the check stopped: ${(error as Error).message}`);
  } finally {
    await egress.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  for (const [stage, checks] of [["stage2", stage2], ["stage3", stage3]] as const) {
    for (const [name, check] of Object.entries(checks)) if (check.ok === false) failures.push(`${stage}.${name} failed`);
  }
  for (const name of ["tools_off", "env_allowlist", "limits", "pins", "side_requests"]) if (!(name in stage2) && !failures.some((f) => f.startsWith("the check stopped"))) failures.push(`stage2.${name} did not run`);
  for (const name of ["mcp_tool", "resume", "denied_call", "other_runner"]) if (!(name in stage3) && !failures.some((f) => f.startsWith("the check stopped"))) failures.push(`stage3.${name} did not run`);
  // A pass is noted on the data directory, by digest, for a server that names the recipe (harness-recipe-entry.ts
  // recipeServerEntry): it runs this recipe and this install's tree, and no other.
  if (failures.length === 0) writeChecked(options.data, recipe.id, { recipe: loaded.sha256, tree: install.tree.sha256, platform });
  return {
    ok: failures.length === 0,
    ...head,
    platform,
    ...(options.model ? { model: options.model } : {}),
    binary: { path: binary, tree: install.tree.sha256, pinnedBy: install.tree.by },
    stage2,
    stage3,
    facts: { resume: resumeFact, tool_gate: asked().length > 0 ? "permission" : "config", billing: recipe.model.billing },
    // How the tool gate was reached: each permission the agent asked for, and each question the gate was asked.
    gate: {
      permissionsAsked: asked().map((l) => ({ toolCallId: l.toolCallId ?? null, kind: l.kind ?? null })),
      asked: gateAsked,
    },
    spendUsd: lastBooking ? lastBooking.spentUsd() : 0,
    failures,
  };
}

/** The three facts and the verdict, as the command prints them. */
export function printedFacts(report: HarnessCheckReport): string[] {
  if (report.refused) return [`harness-check: refused: ${report.refused.message}`];
  const lines: string[] = [];
  for (const [stage, checks] of [["stage 2", report.stage2 ?? {}], ["stage 3", report.stage3 ?? {}]] as const) {
    for (const [name, check] of Object.entries(checks)) lines.push(`${stage} ${name}: ${check.ok === true ? "pass" : check.ok === false ? "FAIL" : `unverified (${String(check.why ?? "")})`}`);
  }
  lines.push(`resume: ${report.facts?.resume}`, `tool_gate: ${report.facts?.tool_gate}`, `billing: ${report.facts?.billing}`);
  lines.push(`spend: ${report.spendUsd === null || report.spendUsd === undefined ? "unknown" : `$${report.spendUsd.toFixed(5)}`}`);
  lines.push(`harness-check: ${report.ok ? "passed" : `FAILED (${report.failures.join("; ")})`}`);
  return lines;
}

/** Writes the report to `file`. */
export const writeReport = (file: string, report: HarnessCheckReport): Promise<void> => writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
