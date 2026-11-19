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
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HostTool, SessionRecord, SessionStore } from "@parcha/agentrun-kernel";
import { modelPortFor, SessionFenced } from "@parcha/agentrun-kernel";
import { beforeRequestOf } from "@parcha/agentrun-kernel/kernel/cap";
import { ACP_PACKAGE } from "./acp-package.js";
import { priceOf } from "./adapters.js";
import { archivePlatform } from "./harness-archive.js";
import { installDirOf } from "./harness-install.js";
import { loadRecipe, pinnedDigest, type Recipe, recipeBinaryOf, recipeInstallLine, RecipeRefused, releaseFor } from "./harness-recipe.js";
import { providerModels } from "./model.js";
import { providerFor } from "./provider.js";
import { capModelOf } from "./runner/cli-run-spec.js";
import { keyShaped } from "./secret-name.js";
import { SECRET_NAMES } from "./secrets.js";
import { createRequire } from "node:module";

/** What the check reads of the ACP package. */
type AcpCheckPackage = {
  acpAdapter(options: Record<string, unknown>): AgentAdapter;
  gooseProxy(options: Record<string, unknown>): unknown;
  RESERVED_ENV: readonly string[];
  GOOSE_OWN_TOOLS: readonly string[];
};

const requireHere = createRequire(import.meta.url);

/** The ACP package beside this server, or undefined. */
function acpCheckPackage(): AcpCheckPackage | undefined {
  try {
    requireHere.resolve(ACP_PACKAGE);
  } catch {
    return undefined;
  }
  return requireHere(ACP_PACKAGE) as AcpCheckPackage;
}

/** The variables the agent's process takes from the host (run-adapters-acp's INHERITED_ENV). */
const INHERITED = ["PATH", "LANG", "TZ"];
/** The proxy variables the check points at its own egress proxy, in both cases, whatever the recipe sets. */
const EGRESS_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
const NO_PROXY_VARS = ["NO_PROXY", "no_proxy"];
/** The proxy's variables for the agent: its address (under the recipe's hostEnv) and its key. */
const PROXY_VARS = ["ANTHROPIC_HOST", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"];
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
  binary?: { path: string; sha256: string; pinnedBy: "recipe" | "first-seen" };
  stage2?: Record<string, Check>;
  stage3?: Record<string, Check>;
  facts?: { resume: "load" | "restart" | "unknown"; tool_gate: "permission" | "config"; billing: "proxy" | "plan" };
  gate?: { permissionsAsked: { toolCallId: unknown; kind: unknown }[]; asked: { tool: string; about: string; answer: string }[] };
  spendUsd?: number | null;
  checkedAt: string;
  failures: string[];
}

/** The sha256 of the file at `path`. */
const fileDigest = (path: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
});

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

const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the one address the refusing egress proxy of a check listens on

/** A loopback HTTP proxy that records what the agent reaches for beyond loopback. It tunnels a CONNECT to one of `vendor`
 *  (a plan-billed recipe's model.hosts, `host` for port 443 or `host:port`) and refuses everything else. */
async function egressProxy(vendor: readonly string[] = []): Promise<{ url: string; asked: { method: string; target: string; tunneled: boolean }[]; close(): Promise<void> }> {
  const asked: { method: string; target: string; tunneled: boolean }[] = [];
  const sockets = new Set<Socket>();
  const allowed = new Set(vendor.map((host) => (host.includes(":") ? host : `${host}:443`)));
  const server = createServer((req, res) => {
    asked.push({ method: req.method ?? "GET", target: req.url ?? "", tunneled: false });
    res.writeHead(403).end();
  });
  server.on("connect", (req, socket: Socket, head: Buffer) => {
    const target = req.url ?? "";
    const tunneled = allowed.has(target);
    asked.push({ method: "CONNECT", target, tunneled });
    if (!tunneled) return void socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    const at = target.lastIndexOf(":");
    const upstream = netConnect({ host: target.slice(0, at), port: Number(target.slice(at + 1)) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => (sockets.delete(upstream), socket.destroy()));
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"));
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  server.on("connection", (socket) => (sockets.add(socket), socket.on("close", () => sockets.delete(socket))));
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://${LOOPBACK}:${port}`,
    asked,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

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

/** Runs the check. Never throws for what it judges: a refused recipe, a missing install or a failed stage is in the
 *  report (`ok: false`, `failures`). */
export async function harnessCheck(options: HarnessCheckOptions): Promise<HarnessCheckReport> {
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
  const head = { recipe: { id: recipe.id, label: recipe.label, file: loaded.file, sha256: loaded.sha256 }, checkedAt } as const;
  const refuse = (code: string, message: string): HarnessCheckReport => ({ ok: false, ...head, refused: { code, message: `${code}: ${message}` }, failures: [`${code}: ${message}`] });
  say(`${recipe.label}: the recipe holds the five rules (${loaded.file})`);

  // Stage 2's pins: the installed binary, the one the owner's install put there. Nothing is downloaded here.
  const platform = options.platform ?? archivePlatform();
  const release = releaseFor(recipe, platform);
  if (!platform || !release) return refuse("HARNESS_PLATFORM_UNSUPPORTED", `${recipe.label} ${recipe.release.version} has no release for ${platform ?? `${process.platform}-${process.arch}`}`);
  const binary = recipeBinaryOf(options.data, recipe, release);
  const line = recipeInstallLine(loaded.file, options.data, options.env);
  const pin = pinnedDigest(options.data, recipe, release, platform);
  if (!existsSync(binary) || !pin) return refuse("HARNESS_NOT_INSTALLED", `${recipe.label} ${recipe.release.version} is not installed in ${installDirOf(options.data, recipe.id)}; a check never downloads it. Install it with: ${line}`);
  const found = await fileDigest(binary).catch(() => undefined);
  if (found !== pin.sha256) return refuse(pin.by === "recipe" ? "ACP_BINARY_MISMATCH" : "ACP_BINARY_DRIFT", `${binary} has sha256 ${found ?? "(unreadable)"}, and ${pin.by === "recipe" ? "the recipe pins" : "its first install recorded"} ${pin.sha256}. Install it again with: ${line}`);
  say(`${recipe.label}: the binary is the pinned one (${pin.by === "recipe" ? "the recipe's sha256" : "the first sha256 its install recorded"})`);

  const acp = acpCheckPackage();
  if (!acp) return refuse("HARNESS_NOT_INSTALLED", `the ACP adapter (${ACP_PACKAGE}) is not installed beside this server`);

  // The model, and who bills it.
  const env = options.env;
  let provider: ReturnType<typeof providerFor> | undefined;
  let price: ((model: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => number | null) | undefined;
  let capModel: ReturnType<typeof capModelOf> | undefined;
  if (recipe.model.billing === "proxy") {
    const ref = options.model ? modelRef(options.model) : undefined;
    if (!ref) return refuse("HARNESS_CHECK_USAGE", `${recipe.label} is billed through the proxy: name the run's model with --model provider/model-id (openrouter/anthropic/claude-haiku-4.5, anthropic/claude-haiku-4-5)`);
    try {
      provider = providerFor("anthropic-messages", env, ref, recipe.label);
    } catch (error) {
      return refuse("HARNESS_CHECK_MODEL", (error as Error).message);
    }
    if (provider.login) return refuse("HARNESS_CHECK_MODEL", `${recipe.label} runs on a model key: Claude Code's login on this machine is its CLI's alone`);
    const models = await providerModels(env);
    const listed = models.getModel(provider.priceModel.provider, provider.priceModel.modelId) as { cost?: Record<string, number>; maxTokens?: number } | undefined;
    price = priceOf({ model: provider.priceModel, models });
    capModel = capModelOf(provider.priceModel.modelId, "anthropic-messages", listed as never, listed === undefined);
    if (!capModel.price) return refuse("HARNESS_CHECK_MODEL", `${provider.priceModel.provider}/${provider.priceModel.modelId} has no price here, so the check's cap could not hold; name a priced model`);
  }

  // The session: the check's tools, its gate, its egress proxy, the recording fetch.
  const nonce = randomBytes(6).toString("hex");
  const echoed: unknown[] = [];
  const deniedRan: unknown[] = [];
  const tools: HostTool[] = [
    { name: "check_echo", description: "Echo the text back, prefixed with ECHO.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, replay: "never", call: async (args) => (echoed.push(args), { text: `ECHO:${(args as { text?: unknown })?.text ?? ""}` }) },
    { name: "check_denied", description: "A tool this run refuses: calling it shows the refusal.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, replay: "never", call: async (args) => (deniedRan.push(args), { text: "this call should never have run" }) },
  ];
  // The gate answers by the tool a call is about: our own tool by its name (asked at the MCP call), or a permission the
  // adapter could not tie to a call of ours (`acp_<kind>`) by the tool its title names, as the agent writes it: Goose
  // 1.59.2 titles it `agentrun: check echo`. check_echo is allowed; check_denied, and everything of the agent's own, is
  // denied.
  const gateAsked: { tool: string; about: string; answer: string }[] = [];
  const named = (title: unknown): string => {
    const words = typeof title === "string" ? title : "";
    const said = (name: string) => [name, name.replace(/_/g, " ")].some((form) => new RegExp(`(^|[^A-Za-z0-9_]|__)${form}([^A-Za-z0-9_]|$)`).test(words));
    return tools.map((tool) => tool.name).find(said) ?? words.slice(0, 80);
  };
  const gate = async (call: { tool: string; args?: unknown }) => {
    const about = call.tool.startsWith("acp_") ? named((call.args as { title?: unknown } | undefined)?.title) : call.tool;
    const answer = about === "check_echo" ? "allow" : "deny";
    gateAsked.push({ tool: call.tool, about, answer });
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
  const hostEnv = { ...env, HARNESS_CHECK_CANARY: canary };
  // The values of every key the host holds, the server's own included: withSecrets keeps those off its enumeration
  // (so the spread above drops them), so each is read by name.
  const hostSecrets = [...new Set([...SECRET_NAMES, ...Object.keys(env).filter((name) => keyShaped(name))])]
    .filter((name) => !recipe.keys.includes(name))
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && value.length >= 8);
  const childVars: Record<string, string> = { ...recipe.env };
  if (recipe.model.billing === "proxy") childVars[recipe.model.env] = provider!.modelId;
  for (const name of recipe.keys) if (env[name]) childVars[name] = env[name]!;
  for (const name of EGRESS_VARS) childVars[name] = egress.url;
  for (const name of NO_PROXY_VARS) childVars[name] = `${LOOPBACK},localhost`; // key-gate: loopback-rule the hosts the agent reaches without the refusing proxy: the model proxy and MCP on this machine
  const acpRecipe = {
    id: recipe.id,
    label: recipe.label,
    command: binary,
    args: [...recipe.args],
    env: childVars,
    files: { ...recipe.files },
    state: [...recipe.state],
    declares: { ...recipe.declares },
    billing: recipe.model.billing === "proxy" ? { kind: "proxy" } : { kind: "plan", maxTurns: recipe.model.maxTurns, maxToolCalls: recipe.model.maxToolCalls },
    ...(recipe.quirks.mcpCall ? { quirks: { mcpCall: recipe.quirks.mcpCall } } : {}),
  };
  // The session's model proxy (the one on Anthropic's Messages there is, Goose's policy), its address under the variable
  // the recipe names.
  type Proxy = (session: unknown) => Promise<{ env: Record<string, string>; close(): Promise<void> }>;
  const messagesProxy = recipe.model.billing === "proxy" ? (acp.gooseProxy({ model: provider!.modelId, provider: { origin: provider!.origin, credential: provider!.credential, ...(provider!.auth ? { auth: provider!.auth } : {}) }, ...(price ? { price } : {}), log, fetch: recording }) as Proxy) : undefined;
  const proxyAt: string = recipe.model.billing === "proxy" ? (recipe.model.hostEnv ?? "ANTHROPIC_HOST") : "ANTHROPIC_HOST";
  const proxy: Proxy | undefined = messagesProxy && (async (session) => {
    // The proxy's own address, under proxyAt, beside the key that opens it alone (never a provider's).
    const started = await messagesProxy(session);
    const { ANTHROPIC_HOST: address, ...opens } = started.env;
    return { env: { ...opens, [proxyAt]: address! }, close: started.close };
  });
  let capUsd: number | undefined = options.capUsd ?? CHECK_DEFAULT_CAP_USD;
  const store = checkStore();
  const starts: string[] = [];
  const adapterFor = (sessionsDir: string) => acp.acpAdapter({
    recipe: acpRecipe,
    sessionsDir,
    env: hostEnv,
    log,
    // Each start of the agent's process checks the pin again: a binary swapped after the check began never runs.
    beforeStart: async (command: string) => {
      const now = await fileDigest(command);
      starts.push(now);
      if (now !== pin.sha256) throw new Error(`ACP_BINARY_DRIFT: ${command} changed after the check began (sha256 ${now})`);
    },
    ...(proxy ? { proxy } : {}),
  });
  const refusedRequests: { reason: string; code?: string; message?: string }[] = [];
  let lastBooking: Awaited<ReturnType<typeof modelPortFor>> | undefined;
  const sessionOn = async (sessionsDir: string) => {
    const writer = await store.open("check");
    const booking = await modelPortFor(writer, {
      key: "check",
      ...(capModel ? { beforeRequest: beforeRequestOf({ capUsd: () => capUsd, modelOf: () => capModel! }) } : {}),
      stop: (reason, message, code) => (refusedRequests.push({ reason, ...(code ? { code } : {}), ...(message ? { message } : {}) }), new Error(`${code ?? reason}: ${message ?? ""}`)),
    });
    lastBooking = booking;
    const controller = new AbortController();
    const session = await adapterFor(sessionsDir).open({ key: "check", label: "root", system: [], tools, context: "fresh" }, { writer, models: booking.models, signal: controller.signal, onEvent: () => {}, gate } as never);
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

    // Stage 2: the tools the agent offered its model on its first request.
    if (recipe.model.billing === "proxy") {
      const firstRequest = messages()[0];
      const ours = new Set(tools.map((tool) => `agentrun__${tool.name}`));
      const own = new Set(acp.GOOSE_OWN_TOOLS);
      const offered = firstRequest?.tools ?? [];
      const theirs = offered.filter((name) => !ours.has(name));
      const refusals = logs.filter((l) => /refus/i.test(l.message)).map((l) => ({ message: l.message, ...(typeof l.reason === "string" ? { reason: l.reason } : {}) }));
      stage2.tools_off = { ok: !!firstRequest && theirs.every((name) => own.has(name)), firstRequest: offered, notOurs: theirs, proxyAllows: [...own], ...(refusals.length ? { proxyRefusals: refusals } : {}) };
    } else stage2.tools_off = { ok: null, why: "plan billing: the vendor's model requests never reach this host, so the tools it offers are not seen" };

    // Stage 2: the environment is the allowlist.
    if (environ) {
      const expected = new Set([...INHERITED, ...acp.RESERVED_ENV, ...Object.keys(childVars), ...PROXY_VARS, ...SHELL_OWN]);
      const extra = Object.keys(environ).filter((name) => !expected.has(name)).sort();
      const leaked = Object.entries(environ).filter(([, value]) => hostSecrets.includes(value) || value === canary).map(([name]) => name).sort();
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
    const deniedAsked = gateAsked.filter((g) => g.about === "check_denied");
    stage3.denied_call = { ok: deniedAsked.length >= 1 && deniedAsked.every((g) => g.answer === "deny") && deniedRan.length === 0 && t2.status === "completed", gateAsked: deniedAsked.length, askedAs: [...new Set(deniedAsked.map((g) => g.tool))], ran: deniedRan.length, turn: t2.status };
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
    stage2.pins = { ok: starts.length > 0 && starts.every((sha) => sha === pin.sha256), binary, sha256: pin.sha256, pinnedBy: pin.by, archiveSha256: release.sha256, starts: starts.length };
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
  return {
    ok: failures.length === 0,
    ...head,
    platform,
    ...(options.model ? { model: options.model } : {}),
    binary: { path: binary, sha256: pin.sha256, pinnedBy: pin.by },
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
