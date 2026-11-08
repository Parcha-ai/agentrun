// Connect GitHub: this server's one GitHub App, made with GitHub's app-manifest flow and kept in the github source's
// sealed settings (DIR/trigger-settings-github.json): its id, slug and client id, which are no secret, its private key
// and webhook secret, which are, and the installations it has. The owner's console asks for a manifest (start), posts it
// to GitHub, and GitHub sends the browser back with a code (callback), which is converted into the App's credentials,
// then again once the App is installed (installed). Every github trigger, and every GitHub template, uses this one App.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, invalid } from "./errors.js";
import { appJwt, GITHUB_WEB, githubCall } from "./github.js";
import type { SealedSettings } from "./sealed-settings.js";
import { isObject, type Json } from "./validate.js";

/** How long a Connect's state is good for, and the most kept at once. */
export const STATE_MS = 60 * 60 * 1000;
const MAX_STATES = 100;
export const CALLBACK_PATH = "/v2/integrations/github/callback";
export const INSTALLED_PATH = "/v2/integrations/github/installed";
export const HOOK_PATH = "/v2/hooks/github";
/** The App's fields in the github source's sealed settings (trigger-github.ts declares them). */
export const FIELDS = { appId: "app_id", slug: "slug", clientId: "client_id", settingsUrl: "settings_url", privateKey: "private_key", webhookSecret: "webhook_secret", installations: "installations" } as const;
/** Where a browser leg sends the owner's browser: the console's GitHub settings (it routes by hash), connected, or with
 *  why not. */
export const CONNECTED_PAGE = "/#/settings/github?github=connected";
export type LegFailure = "state_invalid" | "conversion_failed" | "installation_unverified";
const failedPage = (reason: LegFailure) => `/#/settings/github?github=error&reason=${reason}`;
/** A GitHub login (a user or an organization), as GitHub allows one. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const SCOPE = "server";

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
/** The cookie a start sets in the browser that started it, which the callback must bring: no other browser finishes it. */
export const stateCookie = (port: number | undefined, state: string, https: boolean, maxAgeS = STATE_MS / 1000) =>
  `${cookieName(port, state)}=${maxAgeS ? state : ""}; HttpOnly; SameSite=Lax; Path=${CALLBACK_PATH}; Max-Age=${maxAgeS}${https ? "; Secure" : ""}`;
/** Whether the callback's request carries the cookie its state's start set. */
export function startedHere(cookies: string | undefined, port: number | undefined, state: string): boolean {
  const name = `${cookieName(port, state)}=`;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return String(cookies ?? "").split(";").map((part) => part.trim()).some((part) => part.startsWith(name) && timingSafeEqual(digest(part.slice(name.length)), digest(state)));
}

/** The connection, as the github source's sealed settings hold it. */
export class GitHubConnection {
  constructor(private readonly settings: SealedSettings | undefined) {}

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

  /** Why nothing can be kept (no seal key, an unreadable file), as its refusal. */
  unwritable(): ApiError | undefined {
    const refusal = this.settings ? this.settings.unwritable() : new ApiError("no_sealing_key", "");
    if (refusal?.code === "no_sealing_key") return new ApiError("github_no_seal_key", "This server keeps a GitHub App's secrets only sealed, and it has no seal key: set AGENTRUN_SEAL_KEY, restart it, then connect again.");
    return refusal;
  }

  /** The App's settings page on GitHub, where the person deletes it: its owner's (an organization's, or the user's). */
  settingsUrl(): string | undefined {
    return this.get(FIELDS.settingsUrl);
  }

  /** The App GitHub made, kept: its client secret is never. Its installations start empty. */
  save(app: { id: string; slug: string; clientId: string; pem: string; webhookSecret: string; settingsUrl: string }): void {
    const settings = this.settings!;
    settings.set(SCOPE, FIELDS.privateKey, app.pem);
    settings.set(SCOPE, FIELDS.webhookSecret, app.webhookSecret);
    settings.set(SCOPE, FIELDS.clientId, app.clientId);
    settings.set(SCOPE, FIELDS.settingsUrl, app.settingsUrl);
    settings.set(SCOPE, FIELDS.slug, app.slug);
    settings.set(SCOPE, FIELDS.installations, "[]");
    // Last: a connection reads as there only once every field is.
    settings.set(SCOPE, FIELDS.appId, app.id);
  }

  addInstallation(installation: Installation): void {
    this.settings!.set(SCOPE, FIELDS.installations, withInstallation(installationsIn(this.get(FIELDS.installations)), installation));
  }

  /** The connection gone from this server: every field. The App itself stays on GitHub. */
  remove(): void {
    this.settings?.remove(SCOPE);
  }
}

/** The Connect flow's three steps, for one server: its public address (GitHub calls it), GitHub's API (a test's fake),
 *  and where a step that finished sends the browser. */
export class GitHubConnect {
  readonly states: ManifestStates;
  constructor(
    private readonly connection: GitHubConnection,
    private readonly options: { publicUrl?: string; api: string; say: (fields: Record<string, string>) => void; now?: () => number },
  ) {
    this.states = new ManifestStates(options.now);
  }

  /** POST /integrations/github/connect: the form the console posts to GitHub (its action, with the state, and the
   *  manifest), refused while GitHub could not reach this server, nothing could be kept, or an App is connected. */
  start(body: Json): { action: string; manifest: Json; state: string } {
    const issues = Object.keys(body).filter((key) => key !== "org").map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    if (body.org !== undefined && !(typeof body.org === "string" && LOGIN.test(body.org))) issues.push({ field: "org", reason: "invalid", message: "org is a GitHub organization's login: the App is made under it (absent: under the signed-in GitHub user)" });
    if (issues.length) throw invalid(issues);
    const base = this.options.publicUrl;
    if (!base) throw new ApiError("github_no_public_url", "GitHub can't reach this server: set its public URL first (AGENTRUN_PUBLIC_URL, the https address GitHub sends events to), then connect again.");
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
    return failedPage(reason);
  }

  /** GET /integrations/github/callback, its state checked (the server checks the browser's cookie first): the code
   *  converted into the App's credentials, kept sealed, its client secret dropped; where to send the browser next: to
   *  install the App, or back to the console with state_invalid or conversion_failed. */
  async callback(code: string | null, state: string | null, signal?: AbortSignal): Promise<string> {
    if (!state || !this.states.take(state)) return this.failed("state_invalid", "the state is unknown, used, or over an hour old");
    if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return this.failed("conversion_failed", "GitHub's redirect brought no code");
    if (this.connection.view()) return this.failed("conversion_failed", "a GitHub App is connected already");
    let answer: { status: number; json: unknown };
    try {
      answer = await githubCall(this.options.api, `/app-manifests/${code}/conversions`, { method: "POST", ...(signal ? { signal } : {}) });
    } catch (error) {
      return this.failed("conversion_failed", (error as Error).message);
    }
    const app = isObject(answer.json) ? answer.json : {};
    if (answer.status !== 201 || !Number.isSafeInteger(app.id) || typeof app.slug !== "string" || typeof app.client_id !== "string" || typeof app.pem !== "string" || typeof app.webhook_secret !== "string") {
      return this.failed("conversion_failed", `GitHub answered the code's conversion with HTTP ${answer.status}${answer.status === 201 ? " and no App" : ""}`);
    }
    const owner = isObject(app.owner) && typeof app.owner.login === "string" ? app.owner : undefined;
    const settingsUrl = owner?.type === "Organization" ? `${GITHUB_WEB}/organizations/${owner.login}/settings/apps/${app.slug}` : `${GITHUB_WEB}/settings/apps/${app.slug}`;
    try {
      this.connection.save({ id: String(app.id), slug: app.slug, clientId: app.client_id, pem: app.pem, webhookSecret: app.webhook_secret, settingsUrl });
    } catch (error) {
      return this.failed("conversion_failed", `the App's credentials were not kept (${(error as Error).message})`);
    }
    this.options.say({ condition: "github_connected", app_id: String(app.id), slug: app.slug });
    return `${GITHUB_WEB}/apps/${encodeURIComponent(app.slug)}/installations/new`;
  }

  /** GET /integrations/github/installed: the installation GitHub's redirect names, kept once GitHub, asked with the
   *  App's JWT, says it is the App's; where to send the browser: the console, connected or installation_unverified. */
  async installed(installationId: string | null, signal?: AbortSignal): Promise<string> {
    if (!installationId || !/^\d{1,15}$/.test(installationId)) return this.failed("installation_unverified", "GitHub's redirect named no installation");
    const credentials = this.connection.credentials();
    if (!credentials || !this.connection.view()) return this.failed("installation_unverified", "no GitHub App is connected");
    let answer: { status: number; json: unknown };
    try {
      answer = await githubCall(this.options.api, `/app/installations/${installationId}`, { jwt: appJwt(credentials.appId, credentials.pem, this.options.now?.() ?? Date.now()), ...(signal ? { signal } : {}) });
    } catch (error) {
      return this.failed("installation_unverified", (error as Error).message);
    }
    const found = isObject(answer.json) ? answer.json : {};
    const account = isObject(found.account) && typeof found.account.login === "string" ? found.account.login : undefined;
    if (answer.status !== 200 || String(found.id) !== installationId || !account) return this.failed("installation_unverified", `GitHub does not know installation ${installationId} as this App's (HTTP ${answer.status})`);
    this.connection.addInstallation({ id: Number(installationId), account });
    this.options.say({ condition: "github_installed", installation: installationId, account });
    return CONNECTED_PAGE;
  }
}
