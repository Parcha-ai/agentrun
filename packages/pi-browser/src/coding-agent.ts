// The pi coding agent's adapter for the browser and web tools: the same tool contract and page tools as the durable adapter,
// bound to the coding agent's ExtensionAPI. The coding agent has no mid-turn resume, so custody is plain memory: one session
// held until `browser_release`, an idle spell, or `session_shutdown`. Each session is appended to the session file
// (`appendEntry`, never sent to the model) so that a browser a crashed process left running is released when the session is
// next started; a resumed session always opens a fresh browser.
//
// Providers: a local Chrome the package starts under its own profile directory and a free port (never a browser the
// person is using), a CDP endpoint the person names, or Browserbase or Kernel when asked for and its key is set.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BROWSER_TOOLS, WEB_TOOLS, browserSection, type ToolContract } from "./core/contract.js";
import {
  BrowserFailureError, closeDriver, custodyTools, newSessionRecord, notices, sessionSpec,
  type AttachedSession, type CustodyPort, type DriverFactory, type Overrides, type ToolOutput,
} from "./core/custody.js";
import { classifyBrowserError, type BrowserFailure } from "./core/failures.js";
import type { BrowserConfig, BrowserPolicy, BrowserProvider, ReleaseReason, SessionRecord } from "./core/host.js";
import { leaseTag, type LeaseRef } from "./core/lease.js";
import { createRedactor, redactDeep, scrubPageUrl, type Redact } from "./core/redact.js";
import { pageTools, type PageDriver, type ToolCall, type ToolImpl } from "./core/tools.js";
import { createWebTools, type WebBackup, type WebTools } from "./core/web.js";
import { fileEvidenceSink, findChrome, httpBackup } from "./coding-agent-local.js";

/** The session-file entry that records each session's tag and state, so an orphan can be found. */
export const SESSION_ENTRY = "browser.session";

const DEFAULT_POLICY: BrowserPolicy = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 };
const CREATE_DEADLINE_MS = 60_000;
const CONVERSATION = 1;

export type CodingAgentOptions = {
  /** The provider, or a function that makes it when the session starts. Default: chosen by the flags and environment
   *  (`--browser-provider`, `--browser-endpoint`, `--browser-chrome`, `--browser-headed`; `PI_BROWSER_*`). */
  provider?: BrowserProvider | (() => BrowserProvider | Promise<BrowserProvider>);
  /** How the tools drive an attached browser. Default: the Stagehand driver. */
  driver?: DriverFactory<PageDriver>;
  policy?: Partial<BrowserPolicy>;
  /** Fetchers tried when the provider cannot fetch a page. Default: a plain HTTP read of public hosts. */
  backups?: ReadonlyArray<WebBackup>;
  env?: NodeJS.ProcessEnv;
};

const refused = (message: string, code: BrowserFailure["code"] = "browser_unavailable"): BrowserFailureError =>
  new BrowserFailureError({ ok: false, code, retryable: false, effect: "none", message });

type Live = { record: SessionRecord; ref: LeaseRef; driver: PageDriver | null };
type Deps = {
  config: BrowserConfig;
  provider: () => Promise<BrowserProvider>;
  driver: DriverFactory<PageDriver>;
  keep: (customType: string, data: unknown) => void;
  redact: Redact;
  signal: AbortSignal;
};

const now = () => new Date().toISOString();

/** One conversation's custody over a provider: at most one live session, in memory. */
export class LocalCustody implements CustodyPort<PageDriver> {
  private live: Live | null = null;
  private seq = 0;
  private notice: string | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private idle: NodeJS.Timeout | undefined;

  constructor(private readonly d: Deps) {}

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  private save(record: SessionRecord): void {
    this.d.keep(SESSION_ENTRY, { tag: record.tag, resourceId: record.resourceId, state: record.state, reason: record.releaseReason });
  }

  private failure(error: unknown, signal?: AbortSignal): BrowserFailureError {
    return error instanceof BrowserFailureError ? error : new BrowserFailureError(classifyBrowserError(error, false, { aborted: signal?.aborted === true }));
  }

  /** Release every session the branch's entries leave open: a browser a crashed process left running. Never adopted. */
  async releaseOrphans(entries: ReadonlyArray<{ type: string; customType?: string; data?: any }>): Promise<void> {
    const last = new Map<string, any>();
    for (const e of entries) if (e.type === "custom" && e.customType === SESSION_ENTRY && e.data?.tag) last.set(e.data.tag, e.data);
    const open = [...last.values()].filter((entry) => entry.state !== "released");
    if (!open.length) return;
    const provider = await this.d.provider();
    for (const { tag, resourceId } of open) {
      const refs = resourceId ? [{ id: resourceId, tag }] : await provider.findByTag(tag).catch(() => null);
      if (!refs) continue;
      let released = true;
      for (const ref of refs) await provider.release(ref).catch(() => { released = false; });
      if (released) this.d.keep(SESSION_ENTRY, { tag, resourceId, state: "released", reason: "lost" });
    }
  }

  private async attached(live: Live): Promise<AttachedSession<PageDriver>> {
    const provider = await this.d.provider();
    const signal = AbortSignal.any([this.d.signal, AbortSignal.timeout(CREATE_DEADLINE_MS)]);
    try {
      live.driver ??= await this.d.driver(await provider.attach(live.ref, signal), signal, { batchTimeoutMs: this.d.config.policy.batchTimeoutMs });
    } catch (error) { throw this.failure(error, signal); }
    const notice = this.notice;
    this.notice = null;
    return { driver: live.driver, tag: live.record.tag, sessionId: live.ref.id, record: live.record, notice, interrupted: null, recorded: !!provider.recordings, effects: null };
  }

  private async launch(overrides: Overrides): Promise<AttachedSession<PageDriver>> {
    const provider = await this.d.provider();
    const tag = leaseTag("pib", this.d.config.run, randomUUID().slice(0, 8), ++this.seq);
    const spec = sessionSpec(this.d.config, tag, overrides);
    const record = newSessionRecord({ plane: "browser", tag, provider: provider.name, spec, at: now() });
    this.save(record);
    const signal = AbortSignal.any([this.d.signal, AbortSignal.timeout(CREATE_DEADLINE_MS)]);
    let live: Live | null = null;
    try {
      const ref = await provider.create(spec, signal);
      Object.assign(record, { state: "live", resourceId: ref.id });
      this.save(record);
      live = { record, ref, driver: null };
      const attached = await this.attached(live);
      this.live = live;
      return attached;
    } catch (error) {
      // A create that threw may still have made a browser (the answer lost, the call timed out): when there is no ref, look it up by its
      // tag. The record ends released only when the provider confirmed every release; if the lookup or a release fails it stays open
      // for the next start to find and retry.
      const refs = live ? [live.ref] : await provider.findByTag(tag).catch(() => null);
      let released = refs !== null;
      for (const ref of refs ?? []) if (!(await provider.release(ref).then(() => true, () => false))) released = false;
      if (released) {
        Object.assign(record, { state: "released", releaseReason: "create_failed" });
        this.save(record);
      }
      throw this.failure(error, signal);
    }
  }

  /** Release `live`: the driver closes, the provider releases, then the record ends. A release the provider fails leaves the
   *  session held, so a later release, the shutdown or the next start can retry it, and is the caller's to report. */
  private async finish(live: Live, reason: ReleaseReason): Promise<void> {
    // A close that never comes back (Stagehand after a reconnect) never holds the provider's release.
    if (live.driver) await closeDriver(live.driver);
    try { await (await this.d.provider()).release(live.ref); } catch (error) { throw this.failure(error); }
    if (this.live === live) this.live = null;
    Object.assign(live.record, { state: "released", releaseReason: reason });
    this.save(live.record);
  }

  /** Retire the live session when the provider reports it ended; true when it did. */
  private async retireEnded(): Promise<boolean> {
    const live = this.live;
    if (!live || !["gone", "stopped"].includes(await (await this.d.provider()).status(live.ref).catch(() => "running" as const))) return false;
    this.notice = notices.ended(live.record.lastUrl);
    await this.finish(live, "ended").catch(() => undefined);
    return true;
  }

  session(): Promise<AttachedSession<PageDriver>> {
    return this.serial(async () => {
      await this.retireEnded();
      return this.live ? this.attached(this.live) : this.launch({});
    });
  }

  relaunch(overrides: Overrides): Promise<AttachedSession<PageDriver>> {
    return this.serial(async () => {
      if (this.live) await this.finish(this.live, "relaunch");
      return this.launch(overrides);
    });
  }

  release(): Promise<{ released: boolean; sessionId: string | null }> {
    return this.serial(async () => {
      const live = this.live;
      if (live) await this.finish(live, "tool");
      return { released: !!live, sessionId: live?.ref.id ?? null };
    });
  }

  /** Session end or idle spell: release without failing the caller. Idempotent. */
  close(reason: ReleaseReason): Promise<void> {
    return this.serial(async () => {
      clearTimeout(this.idle);
      if (this.live) await this.finish(this.live, reason).catch(() => undefined);
    });
  }

  async dispatching(): Promise<void> {}
  async journal(): Promise<void> {}
  async settle(): Promise<void> {}

  async navigated(url: string): Promise<void> { if (this.live) this.live.record.lastUrl = scrubPageUrl(url, this.d.redact); }

  ended(): Promise<boolean> {
    return this.serial(() => this.retireEnded());
  }

  /** The connection dropped while the provider still runs the session: the next attach reconnects to it. */
  dropped(): Promise<void> {
    return this.serial(async () => {
      const driver = this.live?.driver;
      if (!driver || !this.live) return;
      this.live.driver = null;
      await closeDriver(driver);
    });
  }

  /** A call began (+1) or ended (-1); a session left idle is released after the policy's idle spell. */
  activity(delta: 1 | -1): void {
    this.inFlight += delta;
    clearTimeout(this.idle);
    if (this.inFlight > 0 || !this.live) return;
    this.idle = setTimeout(() => { void this.close("idle"); }, this.d.config.policy.idleReleaseS * 1000);
    this.idle.unref();
  }
}

type Runtime = {
  redact: Redact;
  web: WebTools;
  call(tool: string, args: unknown, callId: string, signal: AbortSignal | undefined): Promise<ToolOutput>;
  close(): Promise<void>;
};

export function createBrowserExtension(options: CodingAgentOptions = {}): (pi: ExtensionAPI) => void {
  const env = options.env ?? process.env;
  const policy: BrowserPolicy = { ...DEFAULT_POLICY, ...(env.PI_BROWSER_PROXIES === "1" ? { proxies: true } : {}), ...options.policy };
  const impls = { ...custodyTools, ...pageTools() } as unknown as Record<string, ToolImpl<PageDriver> | undefined>;

  return function piBrowser(pi: ExtensionAPI): void {
    let runtime: Runtime | null = null;
    let opening: Promise<Runtime> | null = null;
    let webSearchRegistered = false;

    pi.registerFlag("browser-provider", { type: "string", description: "Browser provider: cdp (a local Chrome, the default), browserbase (needs BROWSERBASE_API_KEY) or kernel (needs KERNEL_API_KEY)" });
    pi.registerFlag("browser-endpoint", { type: "string", description: "Attach to a Chrome DevTools endpoint (http://host:port or ws://...) instead of starting Chrome" });
    pi.registerFlag("browser-chrome", { type: "string", description: "Path to the Chrome or Chromium to start" });
    pi.registerFlag("browser-headed", { type: "boolean", description: "Show the browser window instead of running headless" });
    pi.registerFlag("browser-no-sandbox", { type: "boolean", description: "Start Chrome without its sandbox (needed as root or in a container; only for pages you trust)" });

    const flag = (name: string, fallback?: string): string | undefined => {
      const value = pi.getFlag(name);
      return typeof value === "string" && value ? value : fallback;
    };

    /** The provider the flags and environment name; constructed here, it starts nothing until its first session. */
    async function chooseProvider(profiles: { root: () => Promise<string> }): Promise<BrowserProvider> {
      if (options.provider) return typeof options.provider === "function" ? options.provider() : options.provider;
      const kind = flag("browser-provider", env.PI_BROWSER_PROVIDER ?? "cdp");
      if (kind === "browserbase") {
        if (!(env.BROWSERBASE_API_KEY || env.BB_API_KEY)) throw refused("The browserbase provider needs BROWSERBASE_API_KEY in the environment; none is set. Use the default local browser, or ask the person to set the key.", "auth");
        return (await import("./providers/browserbase.js")).browserbaseProvider({ env });
      }
      if (kind === "kernel") {
        if (!env.KERNEL_API_KEY) throw refused("The kernel provider needs KERNEL_API_KEY in the environment; none is set. Use the default local browser, or ask the person to set the key.", "auth");
        return (await import("./providers/kernel.js")).kernelProvider({ env, stealth: env.PI_BROWSER_STEALTH === "1" });
      }
      if (kind !== "cdp") throw refused(`--browser-provider is "${kind}"; it is cdp, browserbase or kernel.`, "refused");
      const { cdpProvider } = await import("./providers/cdp.js");
      const endpoint = flag("browser-endpoint", env.PI_BROWSER_ENDPOINT);
      if (endpoint) return cdpProvider({ endpoint });
      // A Chrome the person named is used, or refused by name; only when none is named are the usual places searched.
      const named = flag("browser-chrome") ?? (env.PI_BROWSER_CHROME || undefined);
      if (named && !existsSync(named)) throw refused(`The Chrome named by --browser-chrome or PI_BROWSER_CHROME, ${named}, does not exist. Ask the person for the right path.`);
      const executablePath = named ?? findChrome(env);
      if (!executablePath) throw refused("No Chrome or Chromium was found on this machine. Ask the person to install one, or to set PI_BROWSER_CHROME (or pass --browser-chrome) to its path, or --browser-endpoint to a running one.");
      const headed = pi.getFlag("browser-headed") === true || env.PI_BROWSER_HEADED === "1";
      // Absent the flag, the provider reads PI_BROWSER_NO_SANDBOX itself.
      return cdpProvider({ chrome: { executablePath, profileRoot: await profiles.root(), headless: !headed, ...(pi.getFlag("browser-no-sandbox") === true ? { sandbox: false } : {}) } });
    }

    async function open(ctx: ExtensionContext, reason: string): Promise<Runtime> {
      const closing = new AbortController();
      const redact = createRedactor(() => [env.BROWSERBASE_API_KEY ?? "", env.BB_API_KEY ?? "", env.KERNEL_API_KEY ?? ""]);
      let root: Promise<string> | null = null;
      const profiles = { root: () => (root ??= mkdtemp(path.join(os.tmpdir(), "pi-browser-"))) };
      let chosen: Promise<BrowserProvider> | null = null;
      const provider = () => (chosen ??= chooseProvider(profiles));
      const evidence = fileEvidenceSink(path.join(ctx.cwd, ".pi", "browser", "evidence"), ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId?.() ?? randomUUID();
      const config: BrowserConfig = { label: "browser", run: sessionId, policy };
      const driver: DriverFactory<PageDriver> = options.driver ?? (async (target, signal, driverOptions) => (await import("./driver/stagehand.js")).stagehandDriver()(target, signal, driverOptions));
      const custody = new LocalCustody({ config, provider, driver, redact, signal: closing.signal, keep: (type, data) => pi.appendEntry(type, data) });
      // A fork's branch holds its parent's entries: the parent released its own browser when it ended.
      if (reason !== "fork") await custody.releaseOrphans(ctx.sessionManager.getBranch() as never).catch(() => undefined);
      // A person who reads pages needs no browser: when the provider cannot be chosen (no Chrome) the web tools still run
      // on the host's fetchers, and a provider that cannot fetch or search leaves that call to them or refuses it.
      const chosenProvider = await provider().catch(() => null);
      const web = createWebTools({
        name: "provider", evidence, redact: { values: () => [env.BROWSERBASE_API_KEY ?? "", env.BB_API_KEY ?? ""] },
        scope: () => ({ label: "web", proxies: policy.proxies }), backups: options.backups ?? [httpBackup()],
        ...(chosenProvider?.fetch ? { fetch: (request, signal) => chosenProvider.fetch!(request, signal) } : {}),
        ...(chosenProvider?.search ? { search: (request, signal) => chosenProvider.search!(request, signal) } : {}),
      });
      if (chosenProvider?.search && !webSearchRegistered) { register(WEB_TOOLS.find((tool) => tool.name === "web_search")!); webSearchRegistered = true; }
      let closed: Promise<void> | null = null;
      return {
        redact, web,
        async call(tool, args, callId, signal) {
          const impl = impls[tool]!;
          custody.activity(1);
          try {
            const call: ToolCall = { callId, conversationId: CONVERSATION, signal, label: config.label, redact, evidence };
            return await impl(args, custody, call);
          } finally { custody.activity(-1); }
        },
        close: () => (closed ??= (async () => {
          closing.abort();
          await custody.close("close");
          if (root) await root.then((dir) => rm(dir, { recursive: true, force: true })).catch(() => undefined);
        })()),
      };
    }

    const runtimeOf = (ctx: ExtensionContext, reason = "startup"): Promise<Runtime> => runtime ? Promise.resolve(runtime) : (opening ??= open(ctx, reason).then((r) => (runtime = r)));

    const end = async () => {
      const current = runtime ?? (await opening?.catch(() => null)) ?? null;
      runtime = null; opening = null;
      await current?.close();
    };
    pi.on("session_start", async (event, ctx) => { await end(); await runtimeOf(ctx, event.reason); });
    pi.on("session_shutdown", end);

    pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.browser = browserSection(policy); });

    function register(contract: ToolContract): void {
      pi.registerTool({
        name: contract.name,
        label: contract.label,
        description: contract.description,
        promptSnippet: contract.label,
        parameters: contract.parameters as never,
        executionMode: contract.executionMode,
        annotations: contract.effect === "read" ? { readOnlyHint: true, openWorldHint: true } : { readOnlyHint: false, openWorldHint: true },
        async execute(callId, params, signal, _onUpdate, ctx) {
          const rt = await runtimeOf(ctx);
          const web = contract.name === "web_fetch" ? await rt.web.fetch(CONVERSATION, params as never, signal) : contract.name === "web_search" ? await rt.web.search(CONVERSATION, params as never, signal) : null;
          const out: ToolOutput = web ? { content: [{ type: "text", text: web.text }], details: web.details, isError: web.isError } : await rt.call(contract.name, params, callId, signal);
          return { content: out.content, details: out.details ? redactDeep(out.details, rt.redact) : undefined, ...(out.isError ? { isError: true } : {}) };
        },
      });
    }

    for (const contract of BROWSER_TOOLS) if (contract.listedWhen === "always") register(contract);
    register(WEB_TOOLS.find((tool) => tool.name === "web_fetch")!);
  };
}

/** The pi package's extension entry: `pi install` loads this module and calls the default export. */
export default function piBrowser(pi: ExtensionAPI): void {
  createBrowserExtension()(pi);
}
