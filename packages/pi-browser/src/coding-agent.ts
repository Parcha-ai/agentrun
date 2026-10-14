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
import type { BrowserConfig, BrowserPolicy, BrowserProvider, ReleaseReason, SessionRecord, SiteInfo, SiteRunPort } from "./core/host.js";
import { leaseTag, type LeaseRef } from "./core/lease.js";
import { createRedactor, redactDeep, scrubPageUrl, type Redact } from "./core/redact.js";
import { useWebsite, useWebsiteContract } from "./core/sites.js";
import { pageTools, type PageDriver, type ToolCall, type ToolImpl } from "./core/tools.js";
import { CREATE_DEADLINE_MS, DEFAULT_BROWSER_POLICY, idleTracker, keyedSerializer, providerKeyValues, type IdleTracker } from "./core/session-control.js";
import { createWebTools, type WebBackup, type WebTools } from "./core/web.js";
import { fileEvidenceSink, findChrome, httpBackup } from "./coding-agent-local.js";

export { findChrome } from "./coding-agent-local.js";
export const SESSION_ENTRY = "browser.session";

const CONVERSATION = 1;

export type CodingAgentOptions = {
  /** Default: chosen by the `--browser-*` flags and `PI_BROWSER_*` when the session starts. */
  provider?: BrowserProvider | (() => BrowserProvider | Promise<BrowserProvider>);
  /** Default: the Stagehand driver. */
  driver?: DriverFactory<PageDriver>;
  policy?: Partial<BrowserPolicy>;
  /** Fetchers tried when the provider cannot fetch a page. Default: a plain HTTP read of public hosts. */
  backups?: ReadonlyArray<WebBackup>;
  env?: NodeJS.ProcessEnv;
  /** `use_website`'s sites; absent, the tool is not listed. Each child is a pi session with this extension and no
   *  use_website, started through pi's SDK and disposed, so its browser released, when it reports. */
  sites?: SiteRunPort;
};

const BROWSER_FLAGS = ["browser-provider", "browser-endpoint", "browser-chrome", "browser-headed", "browser-no-sandbox"] as const;

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

export class LocalCustody implements CustodyPort<PageDriver> {
  private live: Live | null = null;
  private seq = 0;
  private notice: string | null = null;
  private readonly queue = keyedSerializer();
  private readonly idle: IdleTracker;

  constructor(private readonly d: Deps) {
    this.idle = idleTracker({ idleMs: d.config.policy.idleReleaseS * 1000, onIdle: (key, fired) => void this.serial(async () => {
      if (this.idle.isCurrent(key, fired) && this.live) await this.finish(this.live, "idle").catch(() => undefined);
    }) });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    return this.queue.run(this.d.config.label, run);
  }

  private save(record: SessionRecord): void {
    this.d.keep(SESSION_ENTRY, { tag: record.tag, resourceId: record.resourceId, state: record.state, reason: record.releaseReason });
  }

  private failure(error: unknown, signal?: AbortSignal): BrowserFailureError {
    return error instanceof BrowserFailureError ? error : new BrowserFailureError(classifyBrowserError(error, false, { aborted: signal?.aborted === true }));
  }

  /** Release every session the branch's entries leave open (a browser a crashed process left running); never adopted. */
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
      // A create that threw may still have made a browser: with no ref, look it up by its tag. The record ends released
      // only when every release is confirmed; otherwise it stays open for the next start to retry.
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

  /** A release the provider fails leaves the session held, so a later release, the shutdown or the next start can retry
   *  it. */
  private async finish(live: Live, reason: ReleaseReason): Promise<void> {
    // A close that never comes back (Stagehand after a reconnect) never holds up the provider's release.
    if (live.driver) await closeDriver(live.driver);
    try { await (await this.d.provider()).release(live.ref); } catch (error) { throw this.failure(error); }
    if (this.live === live) this.live = null;
    Object.assign(live.record, { state: "released", releaseReason: reason });
    this.save(live.record);
  }

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

  /** Releases without failing the caller; idempotent. */
  close(reason: ReleaseReason): Promise<void> {
    return this.serial(async () => {
      this.idle.cancel(this.d.config.label);
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

  dropped(): Promise<void> {
    return this.serial(async () => {
      const driver = this.live?.driver;
      if (!driver || !this.live) return;
      this.live.driver = null;
      await closeDriver(driver);
    });
  }

  /** A session left idle is released after the policy's idle spell. */
  activity(delta: 1 | -1): void {
    this.idle.activity(this.d.config.label, delta);
  }
}

type Runtime = {
  redact: Redact;
  web: WebTools;
  searches: boolean;
  sites: SiteInfo[];
  call(tool: string, args: unknown, callId: string, signal: AbortSignal | undefined): Promise<ToolOutput>;
  close(): Promise<void>;
};

type Settings = { options: CodingAgentOptions; env: NodeJS.ProcessEnv; policy: BrowserPolicy; impls: Record<string, ToolImpl<PageDriver> | undefined> };

const flagOf = (pi: ExtensionAPI, name: string, fallback?: string): string | undefined => {
  const value = pi.getFlag(name);
  return typeof value === "string" && value ? value : fallback;
};

async function chooseProvider(pi: ExtensionAPI, { options, env }: Settings, profiles: { root: () => Promise<string> }): Promise<BrowserProvider> {
  if (options.provider) return typeof options.provider === "function" ? options.provider() : options.provider;
  const kind = flagOf(pi, "browser-provider", env.PI_BROWSER_PROVIDER ?? "cdp");
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
  const endpoint = flagOf(pi, "browser-endpoint", env.PI_BROWSER_ENDPOINT);
  if (endpoint) return cdpProvider({ endpoint });
  // A Chrome the person named is used or refused by name, never swapped; only when none is named are the usual
  // places searched.
  const named = flagOf(pi, "browser-chrome") ?? (env.PI_BROWSER_CHROME || undefined);
  if (named && !existsSync(named)) throw refused(`The Chrome named by --browser-chrome or PI_BROWSER_CHROME, ${named}, does not exist. Ask the person for the right path.`);
  const executablePath = named ?? findChrome(env);
  if (!executablePath) throw refused("No Chrome or Chromium was found on this machine. Ask the person to install one, or to set PI_BROWSER_CHROME (or pass --browser-chrome) to its path, or --browser-endpoint to a running one.");
  const headed = pi.getFlag("browser-headed") === true || env.PI_BROWSER_HEADED === "1";
  // Absent the flag, the provider reads PI_BROWSER_NO_SANDBOX itself.
  return cdpProvider({ chrome: { executablePath, profileRoot: await profiles.root(), headless: !headed, ...(pi.getFlag("browser-no-sandbox") === true ? { sandbox: false } : {}) } });
}

async function openRuntime(pi: ExtensionAPI, settings: Settings, ctx: ExtensionContext, reason: string, listSites: boolean): Promise<Runtime> {
  const { options, env, policy, impls } = settings;
  const closing = new AbortController();
  const keyValues = () => providerKeyValues(env);
  const redact = createRedactor(keyValues);
  let root: Promise<string> | null = null;
  const profiles = { root: () => (root ??= mkdtemp(path.join(os.tmpdir(), "pi-browser-"))) };
  let chosen: Promise<BrowserProvider> | null = null;
  const provider = () => (chosen ??= chooseProvider(pi, settings, profiles));
  const evidence = fileEvidenceSink(path.join(ctx.cwd, ".pi", "browser", "evidence"), ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId?.() ?? randomUUID();
  const config: BrowserConfig = { label: "browser", run: sessionId, policy };
  const driver: DriverFactory<PageDriver> = options.driver ?? (async (target, signal, driverOptions) => (await import("./driver/stagehand.js")).stagehandDriver()(target, signal, driverOptions));
  const custody = new LocalCustody({ config, provider, driver, redact, signal: closing.signal, keep: (type, data) => pi.appendEntry(type, data) });
  // A fork's branch holds its parent's entries: the parent released its own browser when it ended.
  if (reason !== "fork") await custody.releaseOrphans(ctx.sessionManager.getBranch() as never).catch(() => undefined);
  // With no provider (no Chrome) the web tools still run on the host's fetchers.
  const chosenProvider = await provider().catch(() => null);
  const web = createWebTools({
    name: "provider", evidence, redact: { values: keyValues },
    scope: () => ({ label: "web", proxies: policy.proxies }), backups: options.backups ?? [httpBackup()],
    ...(chosenProvider?.fetch ? { fetch: (request, signal) => chosenProvider.fetch!(request, signal) } : {}),
    ...(chosenProvider?.search ? { search: (request, signal) => chosenProvider.search!(request, signal) } : {}),
  });
  // A listing that fails is asked again at the next session start.
  const sites = options.sites && listSites ? await options.sites.list(closing.signal).catch(() => []) : [];
  let closed: Promise<void> | null = null;
  return {
    redact, web, searches: !!chosenProvider?.search, sites,
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

function registerTool(pi: ExtensionAPI, contract: ToolContract, runtimeOf: (ctx: ExtensionContext) => Promise<Runtime>): void {
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
      // Every text the model is shown passes the redactor, as the durable adapter does: a snapshot or a run's return value is
      // where a registered key on a page would otherwise appear.
      const content = out.content.map((item) => item.type === "text" ? { ...item, text: rt.redact(item.text) } : item);
      return { content, details: out.details ? redactDeep(out.details, rt.redact) : undefined, ...(out.isError ? { isError: true } : {}) };
    },
  });
}

export function createBrowserExtension(options: CodingAgentOptions = {}): (pi: ExtensionAPI) => void {
  const env = options.env ?? process.env;
  const policy: BrowserPolicy = { ...DEFAULT_BROWSER_POLICY, ...(env.PI_BROWSER_PROXIES === "1" ? { proxies: true } : {}), ...options.policy };
  const impls = { ...custodyTools, ...pageTools() } as unknown as Record<string, ToolImpl<PageDriver> | undefined>;

  return function piBrowser(pi: ExtensionAPI): void {
    let runtime: Runtime | null = null;
    let opening: Promise<Runtime> | null = null;
    let webSearchRegistered = false;
    let sitesRegistered = false;

    pi.registerFlag("browser-provider", { type: "string", description: "Browser provider: cdp (a local Chrome, the default), browserbase (needs BROWSERBASE_API_KEY) or kernel (needs KERNEL_API_KEY)" });
    pi.registerFlag("browser-endpoint", { type: "string", description: "Attach to a Chrome DevTools endpoint (http://host:port or ws://...) instead of starting Chrome" });
    pi.registerFlag("browser-chrome", { type: "string", description: "Path to the Chrome or Chromium to start" });
    pi.registerFlag("browser-headed", { type: "boolean", description: "Show the browser window instead of running headless" });
    pi.registerFlag("browser-no-sandbox", { type: "boolean", description: "Start Chrome without its sandbox (needed as root or in a container; only for pages you trust)" });

    const runtimeOf = (ctx: ExtensionContext, reason = "startup"): Promise<Runtime> => runtime ? Promise.resolve(runtime) : (opening ??= openRuntime(pi, { options, env, policy, impls }, ctx, reason, !sitesRegistered).then((r) => {
      if (r.searches && !webSearchRegistered) { registerTool(pi, WEB_TOOLS.find((tool) => tool.name === "web_search")!, runtimeOf); webSearchRegistered = true; }
      if (options.sites && r.sites.length && !sitesRegistered) { registerSites(options.sites, r.sites); sitesRegistered = true; }
      return (runtime = r);
    }));

    const end = async () => {
      const current = runtime ?? (await opening?.catch(() => null)) ?? null;
      runtime = null; opening = null;
      await current?.close();
    };
    pi.on("session_start", async (event, ctx) => { await end(); await runtimeOf(ctx, event.reason); });
    pi.on("session_shutdown", end);

    pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.browser = browserSection(policy); });

    async function childSession(ctx: ExtensionContext, prompt: string, signal: AbortSignal): Promise<string> {
      const sdk = await import("@earendil-works/pi-coding-agent");
      const model = ctx.model;
      if (!model) throw new Error("this session has no model to give a child");
      const cancelled = () => { if (signal.aborted) throw new Error("the use_website call was cancelled before its child started"); };
      const agentDir = sdk.getAgentDir();
      const modelRuntime = await sdk.ModelRuntime.create();
      // A provider registered at run time (by an extension, or a test) is not in the files a fresh runtime reads.
      const registered = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
      if (registered) modelRuntime.registerProvider(model.provider, registered);
      const flags = new Map<string, string | boolean>();
      for (const flag of BROWSER_FLAGS) { const value = pi.getFlag(flag); if (typeof value === "string" || typeof value === "boolean") flags.set(flag, value); }
      const extension = createBrowserExtension({ ...options, sites: undefined });
      const runtime = await sdk.createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
        const services = await sdk.createAgentSessionServices({
          cwd, agentDir, modelRuntime, extensionFlagValues: flags,
          resourceLoaderOptions: { extensionFactories: [extension], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
        });
        return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: ctx.thinkingLevel, noTools: "builtin" })), services, diagnostics: services.diagnostics };
      }, { cwd: ctx.cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(ctx.cwd) });
      let report = "";
      const stop = runtime.session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        const text = (event.message.content as Array<{ type: string; text?: string }>).filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
        if (text) report = text;
      });
      const abort = () => { runtime.session.abort().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        // A cancel during the setup above has already fired, so the listener never hears it: check before each step.
        cancelled();
        await runtime.session.bindExtensions({});
        cancelled();
        await runtime.session.prompt(prompt);
      } finally {
        signal.removeEventListener("abort", abort);
        stop();
        await runtime.dispose();
      }
      if (!report) throw new Error("the child finished without a report");
      return report;
    }

    function registerSites(port: SiteRunPort, listing: SiteInfo[]): void {
      const contract = useWebsiteContract(listing);
      pi.registerTool({
        name: contract.name,
        label: contract.label,
        description: contract.description,
        promptSnippet: contract.label,
        parameters: contract.parameters as never,
        executionMode: contract.executionMode,
        annotations: { readOnlyHint: false, openWorldHint: true },
        async execute(_callId, params, signal, _onUpdate, ctx) {
          const rt = await runtimeOf(ctx);
          const out = await useWebsite(params as Record<string, unknown>, port, listing, { signal: signal ?? new AbortController().signal, runChild: (task, childSignal) => childSession(ctx, task.prompt, childSignal) });
          return { content: out.content.map((item) => item.type === "text" ? { ...item, text: rt.redact(item.text) } : item), details: undefined, ...(out.isError ? { isError: true } : {}) };
        },
      });
    }

    for (const contract of BROWSER_TOOLS) if (contract.listedWhen === "always") registerTool(pi, contract, runtimeOf);
    registerTool(pi, WEB_TOOLS.find((tool) => tool.name === "web_fetch")!, runtimeOf);
  };
}

export default function piBrowser(pi: ExtensionAPI): void {
  createBrowserExtension()(pi);
}
