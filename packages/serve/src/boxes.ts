// The boxes this server can give a run: Docker, Daytona and a VM provider, each a pi-transport provider built from the
// server's settings and probed once at its start. bwrap comes later. No run uses a box yet: the registry says which boxes
// this server has, why it lacks the others, and hands out an available box's provider.
//
// AGENTRUN_BOXES lists the boxes to set up. A box it does not list is never probed and is unavailable; a name in it that
// is no box refuses the start. pi-transport is an optional peer of this package and the VM provider's SDK is the host's,
// so each is loaded by the probe that needs it, and a box whose module is not installed says what to install. The keys
// are the server's own: the launcher hands them over with its other secrets (secrets.ts), the probes read them here, and
// no run's process is handed one (SERVER_ONLY in runs.ts).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { BoxProvider } from "@parcha/pi-transport";

/** The VM provider: its box id, which is also its SDK's npm name, the SDK's client class and the token's names. */
export const VM_PROVIDER = { id: "modal", client: "ModalClient", keys: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] } as const;
const VM = VM_PROVIDER.id;

/** Every box a place may name, in the order capabilities lists them. */
export const BOX_IDS = ["bwrap", "docker", VM, "daytona"] as const;
export type BoxId = (typeof BOX_IDS)[number];

/** One box: whether this server has it, and why when not (or how it was checked). */
export type BoxOffer = { id: BoxId; available: boolean; reason?: string };

/** The boxes this server set up at its start. */
export type BoxRegistry = {
  /** Every box, in BOX_IDS order. */
  offers(): BoxOffer[];
  /** An available box's provider; undefined for any other. */
  provider(id: BoxId): BoxProvider | undefined;
};

/** The setting that lists the boxes to set up: a comma list of box ids. */
export const BOXES_ENV = "AGENTRUN_BOXES";
/** The VM provider's app, which its sandboxes live in (made when missing). */
export const BOX_APP_ENV = "AGENTRUN_BOX_APP";
const DEFAULT_BOX_APP = "agentrun";
const DAYTONA_KEY = "DAYTONA_API_KEY";
/** The boxes' keys: secrets the server holds and the probes read, which no run's process is handed (runs.ts). */
export const BOX_KEYS: readonly string[] = [DAYTONA_KEY, ...VM_PROVIDER.keys];

/** How long one box's probe may take; the probes run at once, so this bounds them all. */
export const PROBE_TIMEOUT_MS = 5_000;

const NOT_ENABLED = "not enabled on this server";
const NOT_YET = "the bwrap box is not in this release yet";
const NOT_PROBED = "configured; not probed at start";
const TRANSPORT = "@parcha/pi-transport";

type Probed = { offer: BoxOffer; provider?: BoxProvider };
const unavailable = (id: BoxId, reason: string): Probed => ({ offer: { id, available: false, reason } });
const available = (id: BoxId, provider: BoxProvider, reason?: string): Probed => ({ offer: { id, available: true, ...(reason ? { reason } : {}) }, provider });

/** The boxes `env` lists in AGENTRUN_BOXES; a name that is no box throws, naming it. */
export function enabledBoxes(env: NodeJS.ProcessEnv): Set<BoxId> {
  const names = (env[BOXES_ENV] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(BOX_IDS as readonly string[]).includes(name));
  if (unknown.length) throw new Error(`${BOXES_ENV} names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a box" : "are not boxes"}: list any of ${BOX_IDS.join(", ")}`);
  return new Set(names as BoxId[]);
}

/** The boxes `env` (the server's environment, its secrets readable) lists, each probed once, all at once, each within
 *  `timeoutMs`. Rejects only for a name that is no box: a probe that fails, throws or takes too long leaves its box
 *  unavailable, with a short reason that holds no key and no answer's body. */
export async function boxRegistry(env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<BoxRegistry> {
  const enabled = enabledBoxes(env);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probed = await Promise.all(
    BOX_IDS.map((id) => {
      if (id === "bwrap") return unavailable(id, NOT_YET);
      if (!enabled.has(id)) return unavailable(id, NOT_ENABLED);
      return bounded(id, timeoutMs, (signal) => PROBES[id](env, signal));
    }),
  );
  return {
    offers: () => probed.map(({ offer }) => ({ ...offer })),
    provider: (id) => probed.find(({ offer }) => offer.id === id && offer.available)?.provider,
  };
}

/** The start's log line: the boxes available, the rest, and why each box AGENTRUN_BOXES lists is not available. */
export function boxesLog(offers: readonly BoxOffer[]): Record<string, string> {
  const ids = (yes: boolean) => offers.filter((offer) => offer.available === yes).map((offer) => offer.id).join(",") || "none";
  const why = offers.filter((offer) => !offer.available && offer.reason !== NOT_ENABLED && offer.reason !== NOT_YET);
  return { available: ids(true), unavailable: ids(false), ...Object.fromEntries(why.map((offer) => [offer.id, offer.reason ?? ""])) };
}

/** `probe`, aborted after `timeoutMs`. Never rejects. */
async function bounded(id: BoxId, timeoutMs: number, probe: (signal: AbortSignal) => Promise<Probed>): Promise<Probed> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Probed>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(unavailable(id, `its probe did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([probe(controller.signal).catch((error: unknown) => unavailable(id, `its probe failed (${errorName(error)})`)), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What kind of error, never its message: a message can hold an answer's body, a path or a key. */
function errorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return error instanceof Error ? error.name : "not an error";
}

type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string };
/** A module of package `name`, which may not be installed: then the box says to install it. */
async function load<T>(name: string, importer: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await importer() };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | null)?.code === "ERR_MODULE_NOT_FOUND" && String((error as Error).message).includes(`'${name}'`);
    return { ok: false, reason: missing ? `install ${name} to use this box` : `${name} did not load (${errorName(error)})` };
  }
}

const PROBES: Record<Exclude<BoxId, "bwrap">, (env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<Probed>> = {
  /** `docker version` names the daemon's version: the CLI is on PATH and its daemon answers this user. */
  async docker(env, signal) {
    const boxes = await load(TRANSPORT, () => import("@parcha/pi-transport/box/docker").then((module) => module.dockerBoxes));
    if (!boxes.ok) return unavailable("docker", boxes.reason);
    // Its environment is the server's without the boxes' keys; the server's other secrets do not enumerate (withSecrets).
    const dockerEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !BOX_KEYS.includes(name)));
    const answer = await new Promise<{ failed?: string; out: string }>((resolve) =>
      execFile("docker", ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv, signal, maxBuffer: 64 * 1024 }, (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ ...(error ? { failed: typeof code === "number" ? `exit ${code}` : errorName(error) } : {}), out: String(stdout) });
      }),
    );
    if (answer.failed === "ENOENT") return unavailable("docker", "no docker command on this server's PATH");
    if (answer.failed) return unavailable("docker", `docker version failed (${answer.failed}): is the Docker daemon running, and open to this server's user?`);
    if (!answer.out.trim()) return unavailable("docker", "docker version named no Docker daemon");
    return available("docker", boxes.value());
  },

  /** One authenticated read the provider makes anyway: the box with a name no box has (lowercase letters, digits and
   *  dashes). An answer of no such box (404) means Daytona took the key; 401 or 403 means it refused it. */
  async daytona(env, signal) {
    const apiKey = env[DAYTONA_KEY];
    if (!apiKey) return unavailable("daytona", `needs ${DAYTONA_KEY}`);
    const apiUrl = env.DAYTONA_API_URL || undefined;
    if (apiUrl !== undefined && !URL.canParse(apiUrl)) return unavailable("daytona", "DAYTONA_API_URL is not a URL");
    const boxes = await load(TRANSPORT, () => import("@parcha/pi-transport/box/daytona").then((module) => module.daytonaBoxes));
    if (!boxes.ok) return unavailable("daytona", boxes.reason);
    const provider = boxes.value({ apiKey, ...(apiUrl ? { apiUrl } : {}), ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}) });
    const found = await provider.attach(`agentrun-probe-${randomUUID()}`, withAbortSignal(signal, BACKGROUND_CONTEXT));
    if (found.ok) return available("daytona", provider);
    if (found.error.code === "unauthorized") return unavailable("daytona", `Daytona refused ${DAYTONA_KEY}`);
    return unavailable("daytona", `Daytona did not answer the probe (${found.error.code})`);
  },

  /** The SDK is installed and the token is set; nothing is asked of the provider at start. The client gets the token as
   *  arguments: the server's environment does not hold it (secrets.ts). */
  async [VM](env) {
    const missing = VM_PROVIDER.keys.filter((name) => !env[name]);
    if (missing.length) return unavailable(VM, `needs ${missing.join(" and ")}`);
    const boxes = await load(TRANSPORT, () => import("@parcha/pi-transport/box/modal").then((module) => module.modalBoxes));
    if (!boxes.ok) return unavailable(VM, boxes.reason);
    const vmBoxes = boxes.value;
    type Sdk = Parameters<typeof vmBoxes>[0];
    // The SDK is not a dependency of this package (the host installs it), so its name is a value here, not a literal import.
    const sdk = await load(VM, () => import(VM) as Promise<Record<string, unknown>>);
    if (!sdk.ok) return unavailable(VM, sdk.reason);
    const Client = sdk.value[VM_PROVIDER.client];
    if (typeof Client !== "function") return unavailable(VM, `the installed ${VM} package has no ${VM_PROVIDER.client}`);
    const [tokenId, tokenSecret] = VM_PROVIDER.keys.map((name) => env[name] as string);
    let client: Sdk;
    try {
      client = new (Client as new (params: { tokenId: string; tokenSecret: string }) => Sdk)({ tokenId, tokenSecret });
    } catch (error) {
      return unavailable(VM, `its SDK's client did not start (${errorName(error)})`);
    }
    return available(VM, vmBoxes(client, { appName: env[BOX_APP_ENV] || DEFAULT_BOX_APP }), NOT_PROBED);
  },
};
