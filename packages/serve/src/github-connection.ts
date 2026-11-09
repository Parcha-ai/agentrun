// Connect GitHub: this server's one GitHub App, made with GitHub's app-manifest flow and kept in the github source's
// sealed settings (DIR/trigger-settings-github.json): its id, slug and client id, which are no secret, its private key
// and webhook secret, which are, and the installations it has. The owner's console asks for a manifest (start), posts it
// to GitHub, and GitHub sends the browser back with a code (callback), which is converted into the App's credentials,
// then again once the App is installed (installed). Every github trigger, and every GitHub template, uses this one App.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, invalid } from "./errors.js";
import { appJwt, GITHUB_FIELDS, GITHUB_SCOPE, GITHUB_WEB, githubCall, githubTargetOf, mintInstallationToken } from "./github.js";
import type { SealedSettingsOverStore } from "./sealed-settings-store.js";
import { isObject, type Json } from "./validate.js";

/** How long a Connect's state is good for, and the most kept at once. */
export const STATE_MS = 60 * 60 * 1000;
const MAX_STATES = 100;
export const CALLBACK_PATH = "/v2/integrations/github/callback";
export const INSTALLED_PATH = "/v2/integrations/github/installed";
export const HOOK_PATH = "/v2/hooks/github";
/** The App's fields in the github source's sealed settings (trigger-github.ts declares them). */
export const FIELDS = GITHUB_FIELDS;
export { githubTargetOf };
/** Where a browser leg sends the owner's browser: the console's GitHub settings (it routes by hash), connected, or with
 *  why not. */
export const CONNECTED_PAGE = "/#/settings/github?github=connected";
export type LegFailure = "state_invalid" | "conversion_failed" | "already_connected" | "installation_unverified";
const failedPage = (reason: LegFailure) => `/#/settings/github?github=error&reason=${reason}`;
/** A page of the console at this server's public address (where GitHub sends the browser back), else at its own. */
const consoleAt = (base: string | undefined, page: string) => `${base ?? ""}${page}`;
/** A GitHub login (a user or an organization), as GitHub allows one. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const SCOPE = GITHUB_SCOPE;

export type Installation = { id: number; account: string };
/** What a caller (a GitHub template, the console) may read of the connection: never a secret. */
export type GitHubConnectionView = { app_id: string; slug: string; installations: Installation[] };

/** The installations a sealed `installations` field holds; none for one that does not read. */
export function installationsIn(text: string | undefined): Installation[] {
  try {
    const list = JSON.parse(text ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((i): i is Installation => isObject(i) && Number.isSafeInteger(i.id) && typeof i.account === "string") : [];
  } catch {
    return [];
  }
}
/** `list` with `installation` in it (in its place when it is there), as the field keeps it. */
export const withInstallation = (list: Installation[], installation: Installation): string => JSON.stringify([...list.filter((i) => i.id !== installation.id), installation].sort((a, b) => a.id - b.id));
/** `list` without installation `id`, as the field keeps it. */
export const withoutInstallation = (list: Installation[], id: number): string => JSON.stringify(list.filter((i) => i.id !== id));

/** Connect's states: each made for one start, taken once, good for STATE_MS. In memory: a restart ends every Connect
 *  begun before it, which is started again from the console. */
export class ManifestStates {
  private readonly states = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  make(): string {
    const now = this.now();
    for (const [state, expires] of this.states) if (expires <= now || this.states.size >= MAX_STATES) this.states.delete(state);
    const state = randomBytes(32).toString("base64url");
    this.states.set(state, now + STATE_MS);
    return state;
  }

  /** Whether `state` was made here and is within its time; it is gone either way. */
  take(state: string): boolean {
    const expires = this.states.get(state);
    this.states.delete(state);
    return expires !== undefined && expires > this.now();
  }
}

const cookieName = (port: number | undefined, state: string) => `agentrun-github-${port ?? 0}-${createHash("sha256").update(state).digest("hex").slice(0, 16)}`;
/** The cookie a step sets in the browser that took it, which the next step (on `path`: the callback, or the installed
 *  redirect) must bring: no other browser finishes it. */
export const stateCookie = (port: number | undefined, state: string, https: boolean, maxAgeS = STATE_MS / 1000, path = CALLBACK_PATH) =>
  `${cookieName(port, state)}=${maxAgeS ? state : ""}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeS}${https ? "; Secure" : ""}`;
/** Whether the callback's request carries the cookie its state's start set. */
export function startedHere(cookies: string | undefined, port: number | undefined, state: string): boolean {
  const name = `${cookieName(port, state)}=`;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return String(cookies ?? "").split(";").map((part) => part.trim()).some((part) => part.startsWith(name) && timingSafeEqual(digest(part.slice(name.length)), digest(state)));
}

/** The connection, as the github source's sealed settings hold it. */
export class GitHubConnection {
  constructor(private readonly settings: SealedSettingsOverStore | undefined) {}

  /** Bumped by every write of the connection or its installations (an event, the installed redirect, a repair): a
   *  repair reads it before it asks GitHub for the list, and takes the answer only when it has not moved. */
  private written = 0;
  get version(): number {
    return this.written;
  }

  private get(field: string): string | undefined {
    return this.settings?.get(SCOPE, field);
  }

  /** The connection a caller may read, or undefined when there is none (or its secrets do not open under this seal key). */
  view(): GitHubConnectionView | undefined {
    const appId = this.get(FIELDS.appId);
    const slug = this.get(FIELDS.slug);
    if (!appId || !slug || !this.get(FIELDS.privateKey) || !this.get(FIELDS.webhookSecret)) return undefined;
    return { app_id: appId, slug, installations: installationsIn(this.get(FIELDS.installations)) };
  }

  /** The App's id and private key, for its JWT; undefined with no connection. */
  credentials(): { appId: string; pem: string } | undefined {
    const appId = this.get(FIELDS.appId);
    const pem = this.get(FIELDS.privateKey);
    return appId && pem ? { appId, pem } : undefined;
  }

  /** Why nothing can be kept: this server keeps no github source's settings (no such source here). Its seal key is always
   *  there (seal-key.ts ensureSealKey). */
  unwritable(): ApiError | undefined {
    return this.settings ? undefined : new ApiError("unavailable", "This server has no GitHub source to keep an App in.");
  }

  /** The App's settings page on GitHub, where the person deletes it: its owner's (an organization's, or the user's). */
  settingsUrl(): string | undefined {
    return this.get(FIELDS.settingsUrl);
  }

  /** The App GitHub made, kept: its client secret is never. Its installations start empty. */
  async save(app: { id: string; slug: string; clientId: string; pem: string; webhookSecret: string; settingsUrl: string }): Promise<void> {
    const settings = this.settings!;
    this.written++;
    await settings.set(SCOPE, FIELDS.privateKey, app.pem);
    await settings.set(SCOPE, FIELDS.webhookSecret, app.webhookSecret);
    await settings.set(SCOPE, FIELDS.clientId, app.clientId);
    await settings.set(SCOPE, FIELDS.settingsUrl, app.settingsUrl);
    await settings.set(SCOPE, FIELDS.slug, app.slug);
    await settings.set(SCOPE, FIELDS.installations, "[]");
    // Last: a connection reads as there only once every field is.
    await settings.set(SCOPE, FIELDS.appId, app.id);
  }

  /** The installation list as `list`, sorted; whether it changed. */
  // Each write bumps the version as it begins (before its await): a check whose answer comes while it is under way is
  // older than it.
  async setInstallations(list: Installation[]): Promise<boolean> {
    const next = JSON.stringify([...list].sort((a, b) => a.id - b.id));
    if (next === JSON.stringify(installationsIn(this.get(FIELDS.installations)))) return false;
    this.written++;
    await this.settings!.set(SCOPE, FIELDS.installations, next);
    return true;
  }

  async addInstallation(installation: Installation): Promise<void> {
    this.written++;
    await this.settings!.set(SCOPE, FIELDS.installations, withInstallation(installationsIn(this.get(FIELDS.installations)), installation));
  }

  /** Installation `id` gone from the list; how many are left. */
  async removeInstallation(id: number): Promise<number> {
    const list = installationsIn(this.get(FIELDS.installations));
    this.written++;
    await this.settings!.set(SCOPE, FIELDS.installations, withoutInstallation(list, id));
    return list.filter((i) => i.id !== id).length;
  }

  /** The connection gone from this server: every field. The App itself stays on GitHub. */
  async remove(): Promise<void> {
    this.written++;
    await this.settings?.remove(SCOPE);
  }
}

/** An installation event that comes, or is still being checked, as the server stops: 503, so GitHub shows the delivery
 *  failed and it can be sent again. */
const STOPPING = () => new ApiError("unavailable", "The server is stopping; send the delivery again.", { retry_after_ms: 60_000 }, { "retry-after": "60" });

/** The Connect flow's three steps, for one server: its public address (GitHub calls it), GitHub's API (a test's fake),
 *  and where a step that finished sends the browser. */
export class GitHubConnect {
  readonly states: ManifestStates;
  /** The install states a callback sends on to GitHub's install page, which GitHub passes to the setup URL: the one
   *  binding of an installed redirect to the browser that connected. */
  readonly installStates: ManifestStates;
  constructor(
    private readonly connection: GitHubConnection,
    private readonly options: { publicUrl?: string; api: string; say: (fields: Record<string, string>) => void; now?: () => number },
  ) {
    this.states = new ManifestStates(options.now);
    this.installStates = new ManifestStates(options.now);
  }

  /** POST /integrations/github/connect: the form the console posts to GitHub (its action, with the state, and the
   *  manifest), refused while GitHub could not reach this server, nothing could be kept, or an App is connected. */
  start(body: Json, origin: string): { action: string; manifest: Json; state: string } {
    const issues = Object.keys(body).filter((key) => key !== "org").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    if (body.org !== undefined && !(typeof body.org === "string" && LOGIN.test(body.org))) issues.push({ field: "org", reason: "invalid", message: "org is a GitHub organization's login: the App is made under it (absent: under the signed-in GitHub user)" });
    if (issues.length) throw invalid(issues);
    const base = this.options.publicUrl;
    if (!base) throw new ApiError("github_no_public_url", "GitHub can't reach this server: set its public URL first (AGENTRUN_PUBLIC_URL, the https address GitHub sends events to), then connect again.");
    // The state's cookie is set where the console asked from, and GitHub sends the browser back to the public URL: the
    // one origin, or the callback never sees it. Refused before any state is made.
    if (origin !== new URL(base).origin) throw new ApiError("github_wrong_origin", `Open this server at ${base} to connect GitHub.`, { details: { public_url: base } });
    const unwritable = this.connection.unwritable();
    if (unwritable) throw unwritable;
    if (this.connection.view()) throw new ApiError("github_already_connected", "This server already has a GitHub App. Disconnect it first.");
    const state = this.states.make();
    const page = typeof body.org === "string" ? `${GITHUB_WEB}/organizations/${body.org}/settings/apps/new` : `${GITHUB_WEB}/settings/apps/new`;
    const manifest = {
      name: `AgentRun ${randomBytes(3).toString("hex")}`,
      url: base,
      hook_attributes: { url: `${base}${HOOK_PATH}`, active: true },
      redirect_url: `${base}${CALLBACK_PATH}`,
      setup_url: `${base}${INSTALLED_PATH}`,
      setup_on_update: true,
      public: false,
      default_permissions: { pull_requests: "write", contents: "read", metadata: "read", issues: "read" },
      default_events: ["pull_request", "issue_comment"],
    };
    // GitHub reads the state from the form's URL; the form posts only the manifest.
    return { action: `${page}?state=${encodeURIComponent(state)}`, manifest, state };
  }

  /** Where a browser leg that did not finish sends the browser, said once (with no secret): the console, with why. */
  failed(reason: LegFailure, detail: string): string {
    this.options.say({ condition: "github_connect_failed", reason, detail });
    return consoleAt(this.options.publicUrl, failedPage(reason));
  }

  /** GET /integrations/github/callback, its state checked (the server checks the browser's cookie first): the code
   *  converted into the App's credentials, kept sealed, its client secret dropped; where to send the browser next: to
   *  install the App, or back to the console with state_invalid or conversion_failed. */
  async callback(code: string | null, state: string | null, signal?: AbortSignal): Promise<{ location: string; installState?: string }> {
    if (!state || !this.states.take(state)) return { location: this.failed("state_invalid", "the state is unknown, used, or over an hour old") };
    if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return { location: this.failed("conversion_failed", "GitHub's redirect brought no code") };
    if (this.connection.view()) return { location: this.failed("already_connected", "a GitHub App is connected already") };
    let answer: { status: number; json: unknown };
    try {
      answer = await githubCall(this.options.api, `/app-manifests/${code}/conversions`, { method: "POST", ...(signal ? { signal } : {}) });
    } catch (error) {
      return { location: this.failed("conversion_failed", (error as Error).message) };
    }
    const app = isObject(answer.json) ? answer.json : {};
    if (answer.status !== 201 || !Number.isSafeInteger(app.id) || typeof app.slug !== "string" || typeof app.client_id !== "string" || typeof app.pem !== "string" || typeof app.webhook_secret !== "string") {
      return { location: this.failed("conversion_failed", `GitHub answered the code's conversion with HTTP ${answer.status}${answer.status === 201 ? " and no App" : ""}`) };
    }
    // Another Connect may have kept its App while GitHub converted this code: one App per server, the first kept.
    if (this.connection.view()) return { location: this.failed("already_connected", `a GitHub App was connected while GitHub made this one (${app.slug}); delete that one on GitHub`) };
    const owner = isObject(app.owner) && typeof app.owner.login === "string" ? app.owner : undefined;
    const settingsUrl = owner?.type === "Organization" ? `${GITHUB_WEB}/organizations/${owner.login}/settings/apps/${app.slug}` : `${GITHUB_WEB}/settings/apps/${app.slug}`;
    try {
      await this.connection.save({ id: String(app.id), slug: app.slug, clientId: app.client_id, pem: app.pem, webhookSecret: app.webhook_secret, settingsUrl });
    } catch (error) {
      return { location: this.failed("conversion_failed", `the App's credentials were not kept (${(error as Error).message})`) };
    }
    this.options.say({ condition: "github_connected", app_id: String(app.id), slug: app.slug });
    // On to install it, with a fresh install state GitHub passes on to the setup URL (the server sets its cookie).
    const installState = this.installStates.make();
    return { location: `${GITHUB_WEB}/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(installState)}`, installState };
  }

  /** GET /integrations/github/installed: the installation GitHub's redirect names, kept once GitHub, asked with the
   *  App's JWT, says it is the App's; where to send the browser: the console, connected or installation_unverified. It
   *  records one only with the install state its callback sent (`state`, the server checked the browser's cookie for it):
   *  a redirect without it (an install made from GitHub's own pages, or anyone's request) records nothing and lands on the
   *  console, the installation arriving as the App's signed installation event. */
  async installed(installationId: string | null, state: string | null, signal?: AbortSignal): Promise<string> {
    if (!state || !this.installStates.take(state)) {
      this.options.say({ condition: "github_install_unbound", installation: String(installationId ?? "").slice(0, 20) });
      return consoleAt(this.options.publicUrl, CONNECTED_PAGE);
    }
    if (!installationId || !/^\d{1,15}$/.test(installationId)) return this.failed("installation_unverified", "GitHub's redirect named no installation");
    const credentials = this.connection.credentials();
    if (!credentials || !this.connection.view()) return this.failed("installation_unverified", "no GitHub App is connected");
    let account: string | undefined;
    for (let asked = 1; ; asked++) {
      // The list's version before GitHub is asked: a write meanwhile (an installation event, a repair) is newer than
      // GitHub's answer, which is then asked for again, once.
      const version = this.connection.version;
      let answer: { status: number; json: unknown };
      try {
        answer = await githubCall(this.options.api, `/app/installations/${installationId}`, { jwt: appJwt(credentials.appId, credentials.pem, this.options.now?.() ?? Date.now()), ...(signal ? { signal } : {}) });
      } catch (error) {
        return this.failed("installation_unverified", (error as Error).message);
      }
      const found = isObject(answer.json) ? answer.json : {};
      account = isObject(found.account) && typeof found.account.login === "string" ? found.account.login : undefined;
      if (answer.status !== 200 || String(found.id) !== installationId || !account) return this.failed("installation_unverified", `GitHub does not know installation ${installationId} as this App's (HTTP ${answer.status})`);
      // A suspended installation is not one the App can act in: never recorded.
      if (found.suspended_at !== null && found.suspended_at !== undefined) return this.failed("installation_unverified", `installation ${installationId} is suspended on GitHub`);
      // Checked for the App connected when it was asked: one disconnected, or replaced, meanwhile keeps nothing of it.
      if (this.connection.view()?.app_id !== credentials.appId) return this.failed("installation_unverified", "GitHub was disconnected or connected again while the installation was checked");
      if (this.connection.version === version) break;
      if (asked >= 2) return this.failed("installation_unverified", "the installation list was written again while GitHub was asked twice");
    }
    await this.connection.addInstallation({ id: Number(installationId), account: account! });
    this.options.say({ condition: "github_installed", installation: installationId, account });
    return consoleAt(this.options.publicUrl, CONNECTED_PAGE);
  }

  /** An installation event the App's hook verified (trigger-github.ts hands it on): taken only in its own shape (the
   *  installation, its account, and this App's id) and as GitHub, asked with the App's JWT, bears it out now: gone (404)
   *  for deleted, suspended for suspend, there and not suspended for created and unsuspend. X-GitHub-Event is not
   *  signed, so another event's signed body sent as one is never taken. A removal that leaves no installation turns every
   *  github trigger off (`turnOff`), naming it; one added turns none on. */
  installationEvent(doc: unknown, turnOff: (detail: string) => number | Promise<number>): Promise<{ status: number; body: Json }> {
    if (this.stopping.signal.aborted) return Promise.reject(STOPPING());
    const checked = this.checkEvent(doc, turnOff);
    this.track(checked);
    return checked;
  }

  private async checkEvent(doc: unknown, turnOff: (detail: string) => number | Promise<number>): Promise<{ status: number; body: Json }> {
    const action = isObject(doc) && typeof doc.action === "string" ? doc.action.slice(0, 64) : "";
    const noted = { status: 200, body: { ok: "noted", action } };
    const view = this.connection.view();
    const credentials = this.connection.credentials();
    const installation = isObject(doc) && isObject(doc.installation) ? doc.installation : undefined;
    const id = installation?.id;
    const account = isObject(installation?.account) && typeof installation.account.login === "string" ? installation.account.login.slice(0, 200) : undefined;
    if (!view || !credentials || !Number.isSafeInteger(id) || !account || String(installation?.app_id) !== view.app_id) {
      this.options.say({ condition: "github_installation_ignored", action, reason: "not_an_installation_of_this_app" });
      return noted;
    }
    const adds = ["created", "new_permissions_accepted", "unsuspend"].includes(action);
    const removes = action === "deleted" || action === "suspend";
    if (!adds && !removes) return noted;
    // GitHub out of reach (no answer, 429, 5xx) decides nothing: 503, so GitHub shows the delivery failed and it can be
    // sent again; the next read of the connection repairs the list from GitHub's own meanwhile (reconcile).
    const unavailable = (why: string) => {
      this.options.say({ condition: "github_unavailable", action, installation: String(id), reason: why });
      return new ApiError("unavailable", "GitHub could not be asked about this installation; send the delivery again.", { retry_after_ms: 60_000 }, { "retry-after": "60" });
    };
    let answer: { status: number; json: unknown };
    for (let asked = 1; ; asked++) {
      // The list's version before GitHub is asked: a write meanwhile (another event, the installed redirect, a repair) is
      // newer than GitHub's answer, which is then asked for again, once.
      const version = this.connection.version;
      try {
        answer = await githubCall(this.options.api, `/app/installations/${id}`, { jwt: appJwt(credentials.appId, credentials.pem, this.options.now?.() ?? Date.now()), signal: this.stopping.signal });
      } catch (error) {
        if (this.stopping.signal.aborted) throw STOPPING();
        throw unavailable((error as Error).message);
      }
      if (this.stopping.signal.aborted) throw STOPPING();
      if (answer.status === 429 || answer.status >= 500) throw unavailable(`HTTP ${answer.status}`);
      // Checked for the App connected when it came: one disconnected, or replaced, meanwhile takes nothing of it.
      if (this.connection.view()?.app_id !== view.app_id) {
        this.options.say({ condition: "github_installation_ignored", action, installation: String(id), reason: "GitHub was disconnected or connected again while the event was checked" });
        return noted;
      }
      if (this.connection.version === version) break;
      if (asked >= 2) {
        this.options.say({ condition: "github_installation_ignored", action, installation: String(id), reason: "the list was written again while GitHub was asked twice; the next read repairs it" });
        return noted;
      }
    }
    const found = isObject(answer.json) ? answer.json : {};
    const suspended = answer.status === 200 && found.suspended_at !== null && found.suspended_at !== undefined;
    const borne = action === "deleted" ? answer.status === 404 : action === "suspend" ? suspended : answer.status === 200 && !suspended && String(found.app_id) === view.app_id;
    if (!borne) {
      this.options.say({ condition: "github_installation_ignored", action, installation: String(id), reason: `GitHub does not bear it out (HTTP ${answer.status})` });
      return noted;
    }
    if (adds) {
      await this.connection.addInstallation({ id: id as number, account });
      return noted;
    }
    // The last one this server tracks: GitHub's own list, asked first, says whether it was the App's last (an event this
    // server missed may have added others). Only none there turns the github triggers off; others there are the list.
    if (!(this.connection.view()?.installations ?? []).some((i) => i.id !== id)) {
      const version = this.connection.version;
      const listed = await this.listed();
      if (this.stopping.signal.aborted) throw STOPPING();
      if (!listed) throw unavailable("the App's installations could not be listed");
      if (this.connection.view()?.app_id !== view.app_id || this.connection.version !== version) {
        this.options.say({ condition: "github_installation_ignored", action, installation: String(id), reason: "the connection or its list changed while GitHub's list was asked; the next read repairs it" });
        return noted;
      }
      // GitHub's list as it comes, the checked installation included: one unsuspended (or installed again) since its check
      // is active there, and stays.
      if (listed.length) {
        await this.connection.setInstallations(listed);
        this.options.say({ condition: "github_installations_repaired", installations: String(listed.length), was: "1", triggers_off: "0", reason: `installation ${id} ${action === "deleted" ? "deleted" : "suspended"}, and GitHub lists ${listed.some((i) => i.id === id) ? "it active again" : "others"}` });
        return noted;
      }
    }
    const left = await this.connection.removeInstallation(id as number);
    const off = left ? 0 : await turnOff(`The GitHub App's last installation left, installation ${id} (${account}), was ${action === "deleted" ? "deleted" : "suspended"} on GitHub: install the App again, then turn the trigger on.`);
    this.options.say({ condition: "github_installation_lost", installation: String(id), account, action, installations_left: String(left), triggers_off: String(off) });
    return noted;
  }

  /** When the list was last repaired from GitHub's (reconcile). */
  private reconciled = 0;
  /** Aborted as the server closes: a repair's GitHub calls stop waiting, and it writes nothing after. */
  private readonly stopping = new AbortController();
  /** The repairs and installation checks under way, each settled, which close waits for. */
  private readonly pending = new Set<Promise<void>>();

  private track(work: Promise<unknown>): void {
    const settled = work.then(() => undefined, () => undefined);
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }

  /** The installation list repaired from GitHub's own (GET /app/installations with the App's JWT, every page; a suspended
   *  one is not listed), at most once a minute unless `force`: a missed or refused installation event is put right at the
   *  next read of the connection, and at the server's start. The same rule as an event's: a list that comes to hold none
   *  turns every github trigger off (`turnOff`); one dropped only shrinks it. GitHub out of reach leaves it as it is, and
   *  so does a list written meanwhile (an event, the installed redirect), asked once more first: GitHub's answer is
   *  older than that write. Never rejects; after close it does nothing. */
  reconcile(turnOff: (detail: string) => number | Promise<number>, { force = false }: { force?: boolean } = {}): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    const repair = this.repair(turnOff, force).catch((error: unknown) => {
      if (!this.stopping.signal.aborted) this.options.say({ condition: "github_installations_unrepaired", reason: (error as Error).message });
    });
    this.track(repair);
    return repair;
  }

  /** The repairs and installation checks stopped: their GitHub calls aborted, nothing written after this, and each one
   *  ended when it resolves. */
  async close(): Promise<void> {
    this.stopping.abort();
    await Promise.all([...this.pending]);
  }

  private async repair(turnOff: (detail: string) => number | Promise<number>, force: boolean): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const view = this.connection.view();
    if (!view || !this.connection.credentials() || (!force && now - this.reconciled < 60_000)) return;
    this.reconciled = now;
    for (let asked = 1; ; asked++) {
      const version = this.connection.version;
      const found = await this.listed();
      // Read for the App connected when it was asked: one replaced meanwhile takes nothing of it. Nothing after close.
      if (!found || this.stopping.signal.aborted || this.connection.view()?.app_id !== view.app_id) return;
      if (this.connection.version !== version) {
        if (asked < 2) continue;
        this.options.say({ condition: "github_installations_unrepaired", reason: "the list was written again while GitHub was asked twice; the next read repairs it" });
        return;
      }
      const before = this.connection.view()?.installations ?? [];
      if (!(await this.connection.setInstallations(found))) return;
      const off = !found.length && before.length ? await turnOff("GitHub holds no installation of the App left (deleted or suspended there): install the App again, then turn the trigger on.") : 0;
      this.options.say({ condition: "github_installations_repaired", installations: String(found.length), was: String(before.length), triggers_off: String(off) });
      return;
    }
  }

  /** The App's installations as GitHub lists them now, not suspended; undefined when GitHub is out of reach (said) or the
   *  server closes meanwhile. */
  private async listed(): Promise<Installation[] | undefined> {
    const credentials = this.connection.credentials();
    if (!credentials) return undefined;
    const found: Installation[] = [];
    try {
      for (let page = 1; page <= 20; page++) {
        const answer = await githubCall(this.options.api, `/app/installations?per_page=100&page=${page}`, { jwt: appJwt(credentials.appId, credentials.pem, this.options.now?.() ?? Date.now()), signal: this.stopping.signal });
        if (answer.status !== 200 || !Array.isArray(answer.json)) {
          this.options.say({ condition: "github_unavailable", reason: `the App's installations: HTTP ${answer.status}` });
          return undefined;
        }
        for (const item of answer.json) {
          if (!isObject(item) || !Number.isSafeInteger(item.id) || !isObject(item.account) || typeof item.account.login !== "string") continue;
          if (item.suspended_at === null || item.suspended_at === undefined) found.push({ id: item.id as number, account: item.account.login.slice(0, 200) });
        }
        if (answer.json.length < 100) break;
      }
    } catch (error) {
      if (!this.stopping.signal.aborted) this.options.say({ condition: "github_unavailable", reason: `the App's installations: ${(error as Error).message}` });
      return undefined;
    }
    return found;
  }

  /** The App's installation tokens minted and not yet long past their hour, by token: every one is a secret this server
   *  never shows (server-secrets.ts), kept only in memory. */
  private readonly live = new Map<string, number>();

  /** Every installation token minted that may still be in use (its hour, and ten minutes past it). */
  liveTokens(): string[] {
    const now = this.options.now?.() ?? Date.now();
    for (const [token, expires] of this.live) if (expires + 10 * 60_000 < now) this.live.delete(token);
    return [...this.live.keys()];
  }

  /** An installation token for one run, narrowed to the one repository `target` names (github.ts
   *  mintInstallationToken), kept among the live tokens; or why there is none, in words its calls answer. */
  async tokenFor(target: { installation?: number; repo: string } | undefined): Promise<{ token: string; expiresAt: number } | { unusable: string }> {
    if (!target) return { unusable: "No GitHub repository was named for this run: a GitHub event's run has one; another run names it in its input as https://github.com/<owner>/<repo>." };
    const credentials = this.connection.credentials();
    if (!credentials || !this.connection.view()) return { unusable: "This server has no GitHub App: Connect GitHub in Settings." };
    const minted = await mintInstallationToken(this.options.api, credentials.appId, credentials.pem, target, this.options.now?.() ?? Date.now());
    if (!minted.ok) return { unusable: minted.message };
    this.live.set(minted.token, minted.expires_at);
    this.options.say({ condition: "github_token_minted", repository: target.repo });
    return { token: minted.token, expiresAt: minted.expires_at };
  }

  /** An installation token for listing an MCP server's tools as it is saved: the App's first installation, every
   *  repository it covers; or why there is none. */
  async tokenForListing(signal?: AbortSignal): Promise<{ token: string; expiresAt: number } | { unusable: string }> {
    const credentials = this.connection.credentials();
    const view = this.connection.view();
    if (!credentials || !view) return { unusable: "This server has no GitHub App: Connect GitHub in Settings." };
    const first = view.installations[0];
    if (!first) return { unusable: "The GitHub App is not installed anywhere yet: install it on an account, then save the server." };
    try {
      const jwt = appJwt(credentials.appId, credentials.pem, this.options.now?.() ?? Date.now());
      const refused = { unusable: `GitHub gave no token for the App's installation on ${first.account}.` };
      // Which repository is the installation's first: asked with a metadata-read token that never leaves this server
      // (only GitHub's API sees it), revoked at once. The token the listing sends is narrowed to that one repository.
      const scout = await this.mint(first.id, jwt, undefined, refused, signal, { metadata: "read" });
      if ("unusable" in scout) return scout;
      let repo: unknown;
      try {
        const listed = await githubCall(this.options.api, "/installation/repositories?per_page=1", { jwt: scout.token, ...(signal ? { signal } : {}) });
        repo = isObject(listed.json) && Array.isArray(listed.json.repositories) && isObject(listed.json.repositories[0]) ? listed.json.repositories[0].name : undefined;
      } finally {
        await githubCall(this.options.api, "/installation/token", { method: "DELETE", jwt: scout.token }).catch(() => undefined);
      }
      if (typeof repo !== "string" || !repo) return { unusable: `The GitHub App's installation on ${first.account} covers no repository yet: add one to it, then save the server.` };
      // The least a listing needs: metadata read, of one repository; never the App's write permissions, never all of them.
      return await this.mint(first.id, jwt, [repo], refused, signal, { metadata: "read" });
    } catch (error) {
      return { unusable: `GitHub did not give a token: ${(error as Error).message}.` };
    }
  }

  private async mint(installation: number, jwt: string, repositories: string[] | undefined, refused: { unusable: string }, signal?: AbortSignal, permissions?: Record<string, string>): Promise<{ token: string; expiresAt: number } | { unusable: string }> {
    const body = { ...(repositories ? { repositories } : {}), ...(permissions ? { permissions } : {}) };
    const answer = await githubCall(this.options.api, `/app/installations/${installation}/access_tokens`, { method: "POST", jwt, ...(Object.keys(body).length ? { body } : {}), ...(signal ? { signal } : {}) });
    const minted = isObject(answer.json) ? answer.json : {};
    if (answer.status !== 201 || typeof minted.token !== "string" || typeof minted.expires_at !== "string") return refused;
    const expiresAt = Date.parse(minted.expires_at);
    this.live.set(minted.token, Number.isFinite(expiresAt) ? expiresAt : (this.options.now?.() ?? Date.now()) + 60 * 60_000);
    this.options.say({ condition: "github_token_minted", installation: String(installation), repositories: repositories?.join(",") ?? "all" });
    return { token: minted.token, expiresAt: this.live.get(minted.token)! };
  }
}

