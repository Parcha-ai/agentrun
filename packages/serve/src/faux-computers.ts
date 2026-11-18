// --faux's computers: the kind registry serve uses in place of the computer package's when it runs with --faux, as the
// faux model module stands in for a model. The console's real-browser flows drive Settings → Computers and a run's
// desktop with it, with no Docker, no provider and no key that means anything. Only --faux reaches this module.
//
// Four providers, in the computer package's registry shape (SETTING_KINDS, PROVIDERS, servingRefusals):
// - faux-sandbox: a sandbox with one key, FAUX_SANDBOX_KEY. Ready once the key is saved; its test then passes. It starts
//   no computer.
// - faux-broken: a sandbox with no key, whose test always fails: it is never reached. It starts no computer.
// - faux-desktop: a desktop with no key. Its run computer answers screen.shot (a plain grey screen) and input.actions
//   (each action done, none performed). Its watch gives the run's live view grey frames and takes its input, so a --faux
//   run's desktop is watched and taken over through the same proxied viewer a real one's is; the release ends it.
// - faux-dial: a desktop with no key whose machine dials this server, as Fly Machines' and Cloudflare's do (its
//   descriptor's connect is "dial"). Its launch mints the machine a token through the runner's HostedDial, and a machine
//   in this process dials the dial's public address at /v2/computers/attach with it, as agentrun-dial does, answering
//   hello, ping, screen.shot (a grey screen) and input.actions; the run's computer calls go over the socket the runner's
//   hub took. No dial, or one with no public address: its launch refuses in words, as the computer package's does.
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { ATTACH_PATH, ATTACH_SUBPROTOCOL, type HelloResult, type HostedDial, MAX_LINE_BYTES, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "@parcha/agentrun-computer";
import { WebSocket } from "ws";
import type { KeyTable, ProviderFactories } from "./computer-keys.js";
import type { ComputerKind } from "./computer-setting.js";
import type { KindCapabilities, KindRegistry, ProviderEntry, SettingKindSpec } from "./computers.js";
import type { WatchOf } from "./workspace/computer-for-claim.js";
import type { ComputerSettingKind, LaunchedComputer } from "./workspace/resolve-computer.js";

// The computer package's setting kinds and servingRefusals, as its kinds.ts gives them (the swap to its exports
// replaces these two with the package's own).
const SETTING_KINDS: Readonly<Record<ComputerKind, SettingKindSpec>> = {
  none: { machineKinds: [], required: [], optional: [] },
  sandbox: { machineKinds: ["linux"], required: ["exec", "files", "processes"], optional: [] },
  desktop: { machineKinds: ["desktop"], required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "ui", "stream"] },
  phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "ui", "stream"] },
  browser: { machineKinds: ["browser"], required: ["cdp"], optional: ["stream", "downloads"] },
} as unknown as Readonly<Record<ComputerKind, SettingKindSpec>>;
const KIND_NAMES = Object.keys(SETTING_KINDS) as ComputerKind[];

function servingRefusals(capabilities: KindCapabilities, kind: ComputerKind): string[] {
  const spec = Object.hasOwn(SETTING_KINDS, kind) ? SETTING_KINDS[kind] : undefined;
  if (spec === undefined) return [`${JSON.stringify(kind)} is not a setting kind: ${KIND_NAMES.join(", ")}`];
  if (spec.machineKinds.length === 0) return [`kind ${kind} is no computer: no provider serves it`];
  const refusals: string[] = [];
  if (!(spec.machineKinds as readonly string[]).includes(capabilities.kind)) refusals.push(`kind ${kind} is a ${spec.machineKinds.join(" or ")} machine, not a ${capabilities.kind} one`);
  const groups = (Array.isArray(capabilities.groups) ? capabilities.groups : []) as readonly string[];
  const missing = (spec.required as readonly string[]).filter((group) => !groups.includes(group));
  if (missing.length > 0) refusals.push(`kind ${kind} needs groups ${missing.join(", ")}, which the provider does not declare`);
  return refusals;
}

const SANDBOX = { kind: "linux", groups: ["exec", "files", "processes"] } as unknown as KindCapabilities;
const DESKTOP_GROUPS = ["screen", "input.pointer", "input.keys"] as const;
const DESKTOP = { kind: "desktop", groups: [...DESKTOP_GROUPS] } as unknown as KindCapabilities;

const entry = (fields: Omit<ProviderEntry, "kinds">): ProviderEntry =>
  ({ ...fields, kinds: KIND_NAMES.filter((kind) => fields.capabilities.some((one) => servingRefusals(one, kind).length === 0)) }) as ProviderEntry;

const PROVIDERS: readonly ProviderEntry[] = [
  entry({ id: "faux-sandbox", label: "Faux sandbox", keys: [{ name: "FAUX_SANDBOX_KEY", required: true }], mounts: ["bind"], metered: false, capabilities: [SANDBOX] } as Omit<ProviderEntry, "kinds">),
  entry({ id: "faux-broken", label: "Faux broken", keys: [], mounts: ["bind"], metered: false, capabilities: [SANDBOX] } as Omit<ProviderEntry, "kinds">),
  entry({ id: "faux-desktop", label: "Faux desktop", keys: [], mounts: [], metered: false, capabilities: [DESKTOP] } as Omit<ProviderEntry, "kinds">),
  entry({ id: "faux-dial", label: "Faux dial", connect: "dial", keys: [], mounts: [], metered: false, capabilities: [DESKTOP] } as Omit<ProviderEntry, "kinds">),
];

const KEYS: KeyTable = {
  keys: { "faux-sandbox": [{ name: "FAUX_SANDBOX_KEY", option: "apiKey", required: true }], "faux-broken": [], "faux-desktop": [], "faux-dial": [] },
  labels: { "faux-sandbox": "Faux sandbox", "faux-broken": "Faux broken", "faux-desktop": "Faux desktop", "faux-dial": "Faux dial" },
};

/** Each faux provider's account test: faux-sandbox, faux-desktop and faux-dial answer, faux-broken is never reached. */
const FACTORIES: ProviderFactories = {
  "faux-sandbox": () => ({ testConnection: async () => ({ ok: true, value: { detail: "Faux sandbox: the faux account answered (no computer was made)" } }) }),
  "faux-desktop": () => ({ testConnection: async () => ({ ok: true, value: { detail: "Faux desktop: the faux account answered (no computer was made)" } }) }),
  "faux-dial": () => ({ testConnection: async () => ({ ok: true, value: { detail: "Faux dial: the faux account answered (no computer was made)" } }) }),
  "faux-broken": () => ({ testConnection: async () => ({ ok: false, error: { code: "unreachable", message: "faux-broken is --faux's broken provider: it never answers" } }) }),
};

/** A PNG of one grey colour, `width` by `height`. */
function greyPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(0, 9); // greyscale
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0xc0)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

const WIDTH = 1280;
const HEIGHT = 800;

/** How long a faux desktop's watch waits after a frame's ack before it gives the next. */
const FRAME_MS = 1_000;
/** How long a faux dial machine's launch waits for its socket in the dial's hub; and its token's life. */
const DIAL_WAIT_MS = 10_000;
const DIAL_LIFE_MS = 60 * 60_000;

/** A started faux desktop: the claim's LaunchedComputer, with its provider's watch of its screen (ComputerProvider.watch
 *  bound to it), which feeds the run's proxied live view (computer-live.ts) as a real desktop's does. */
export type FauxDesktop = LaunchedComputer & { readonly watch: WatchOf };

/** What serve and its runner take in place of the computer package under --faux. */
export interface FauxComputers {
  readonly kinds: KindRegistry;
  readonly factories: ProviderFactories;
  readonly keyTable: KeyTable;
  /** The claim's launch: a faux desktop, or a faux dial machine over `given.dial` (the runner's HostedDial); the faux
   *  sandboxes start nothing, in words. */
  launch(entry: ProviderEntry, spec: { readonly kind: ComputerSettingKind; readonly keys: Readonly<Record<string, string>> }, given?: { readonly dial?: HostedDial }): Promise<FauxDesktop | LaunchedComputer>;
  /** Whether a provider id is one of these (the claim's launch takes it): any other is the package's. */
  owns(provider: string): boolean;
}

/** --faux's computers: the server's Settings → Computers and start check read them, and its runner's claim launches them. */
export function fauxComputers(): FauxComputers {
  let started = 0;

  /** A faux desktop for a run: ping answers, as every computer's does; screen.shot gives a grey screen, input.actions does
   *  each action and performs none, and its watch gives the same grey frame, the next a second after each ack, and takes every input (performing none) until it
   *  is closed or the desktop is released, which ends it gone. */
  function fauxDesktop(): FauxDesktop {
    const id = `faux-desktop-${++started}`;
    const png = greyPng(WIDTH, HEIGHT);
    const watches = new Set<() => void>();
    const hello: HelloResult = { protocol: "0.2", version: "faux", os: "linux", kind: "desktop", arch: "amd64", groups: [...DESKTOP_GROUPS], screen: { width: WIDTH, height: HEIGHT, scale: 1 } };
    const call = async (method: string, params: Record<string, unknown>) => {
      if (method === "hello") return { ok: true, value: hello };
      if (method === "ping") return { ok: true, value: {} };
      if (method === "screen.shot") return { ok: true, value: { id: `${id}-shot`, data: png.toString("base64"), eof: true, size: png.length, width: WIDTH, height: HEIGHT } };
      if (method === "input.actions") return { ok: true, value: { done: Array.isArray(params.actions) ? params.actions.length : 0 } };
      return { ok: false, error: { code: "unsupported", message: `the faux desktop has no ${method}` } };
    };
    const watch: WatchOf = async (handlers: ScreenWatchHandlers, options: WatchOptions) => {
      let open = true;
      let seq = 0;
      let timer: NodeJS.Timeout | undefined;
      const stop = () => {
        open = false;
        clearTimeout(timer);
        watches.delete(gone);
        options.signal?.removeEventListener("abort", stop);
      };
      const gone = () => {
        if (!open) return;
        stop();
        handlers.ended({ code: "gone", message: `the faux desktop ${id} was released` });
      };
      const give = () => {
        if (!open) return;
        handlers.frame({ seq: ++seq, format: "png", bytes: png, width: WIDTH, height: HEIGHT, frameWidth: WIDTH, frameHeight: HEIGHT }, () => {
          if (open) (timer = setTimeout(give, FRAME_MS)).unref();
        });
      };
      if (options.signal?.aborted) return { ok: false, error: { code: "aborted", message: "the watch was cancelled before it began" } };
      options.signal?.addEventListener("abort", stop, { once: true });
      watches.add(gone);
      setImmediate(give);
      const screen: ScreenWatch = {
        input: async (actions) => (open ? { ok: true, value: { done: actions.length } } : { ok: false, error: { code: "gone", message: `the faux desktop ${id}'s watch is closed` } }),
        close: async () => stop(),
      };
      return { ok: true, value: screen };
    };
    return {
      id,
      groups: [...DESKTOP_GROUPS],
      hello,
      client: { call } as unknown as LaunchedComputer["client"],
      watch,
      release: async () => {
        for (const end of [...watches]) end();
      },
    };
  }

  /** A faux dial machine for a run: its token minted through `dial`, its socket dialled to the dial's public address, and
   *  the run's calls over the connection the dial's hub gives once it attached; its release revokes the token and ends
   *  the socket. Refused in words where the machine has nowhere to dial, or did not attach within DIAL_WAIT_MS. */
  async function fauxDial(dial: HostedDial | undefined): Promise<LaunchedComputer> {
    // The computer package's words for a dial provider with no dial (hosted/provider.ts #dialed).
    if (dial === undefined) throw new Error("Faux dial machines dial in to this server, and this runner runs in a process of its own, with no attach hub to take their socket: start the image with the server options alone, without server-and-runner (outside the image: agentrun-serve without --no-runner)");
    if (!dial.url) throw new Error("Faux dial machines dial in to this server, which has no public address: set AGENTRUN_PUBLIC_URL");
    const name = `faux-dial-${randomBytes(6).toString("hex")}`;
    const token = await dial.tokens.mint(name, { kind: "desktop", os: "linux", arch: "amd64", expiresAt: new Date(Date.now() + DIAL_LIFE_MS) });
    const png = greyPng(WIDTH, HEIGHT);
    const hello: HelloResult = { protocol: "0.2", version: "faux", os: "linux", kind: "desktop", arch: "amd64", groups: [...DESKTOP_GROUPS], screen: { width: WIDTH, height: HEIGHT, scale: 1 } };
    const machine = new WebSocket(`${dial.url.replace(/^http/, "ws")}${ATTACH_PATH}`, ATTACH_SUBPROTOCOL, { headers: { authorization: `Bearer ${token}` }, maxPayload: MAX_LINE_BYTES, perMessageDeflate: false });
    let refused: string | undefined;
    machine.on("error", (error) => void (refused ??= error.message));
    machine.once("unexpected-response", (_req, res) => {
      const words: Buffer[] = [];
      res.on("data", (chunk: Buffer) => words.push(chunk));
      res.on("end", () => void (refused ??= `HTTP ${res.statusCode}: ${Buffer.concat(words).toString("utf8")}`));
      res.on("error", () => void (refused ??= `HTTP ${res.statusCode}`));
    });
    machine.on("message", (data, binary) => {
      if (binary) return;
      let message: { id?: unknown; method?: unknown; params?: { actions?: unknown } };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.id === undefined || typeof message.method !== "string") return;
      const answer = (reply: Record<string, unknown>) => machine.readyState === WebSocket.OPEN && machine.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }));
      if (message.method === "hello") return answer({ result: hello });
      if (message.method === "ping") return answer({ result: {} });
      if (message.method === "screen.shot") return answer({ result: { id: `${name}-shot`, data: png.toString("base64"), eof: true, size: png.length, width: WIDTH, height: HEIGHT } });
      if (message.method === "input.actions") return answer({ result: { done: Array.isArray(message.params?.actions) ? message.params.actions.length : 0 } });
      return answer({ error: { code: -32601, message: `the faux dial machine has no ${message.method}` } });
    });
    const release = async () => {
      machine.close(1000, "released");
      await dial.tokens.revoke(name).catch(() => undefined);
      dial.hub.revoke(name, `${name} was released`);
    };
    const until = Date.now() + DIAL_WAIT_MS;
    for (;;) {
      const connection = dial.hub.connection(name);
      if (connection) return { id: name, groups: [...DESKTOP_GROUPS], hello: connection.hello, client: connection.client, release };
      if (refused !== undefined || Date.now() >= until) {
        await release();
        throw new Error(refused === undefined ? `the faux dial machine ${name} did not dial ${dial.url} within ${DIAL_WAIT_MS / 1000} s` : `the faux dial machine ${name}'s dial to ${dial.url} was refused: ${refused}`);
      }
      await new Promise((done) => setTimeout(done, 25));
    }
  }

  return {
    kinds: { SETTING_KINDS, PROVIDERS, servingRefusals },
    factories: FACTORIES,
    keyTable: KEYS,
    async launch(entryOf, spec, given = {}) {
      if (entryOf.id === "faux-desktop" && spec.kind === "desktop") return fauxDesktop();
      if (entryOf.id === "faux-dial" && spec.kind === "desktop") return fauxDial(given.dial);
      throw new Error(`${entryOf.label} starts no computer: under --faux, only Faux desktop and Faux dial do (set this agent's computer to desktop on one of them, or none)`);
    },
    owns: (provider) => PROVIDERS.some((one) => one.id === provider),
  };
}
