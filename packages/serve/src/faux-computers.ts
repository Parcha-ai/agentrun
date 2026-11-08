// --faux's computers: the kind registry serve uses in place of the computer package's when it runs with --faux, as the
// faux model module stands in for a model. The console's real-browser flows drive Settings → Computers and a run's
// desktop with it, with no Docker, no provider and no key that means anything. Only --faux reaches this module.
//
// Three providers, in the computer package's registry shape (SETTING_KINDS, PROVIDERS, servingRefusals):
// - faux-sandbox: a sandbox with one key, FAUX_SANDBOX_KEY. Ready once the key is saved; its test then passes. It starts
//   no computer.
// - faux-broken: a sandbox with no key, whose test always fails: it is never reached. It starts no computer.
// - faux-desktop: a desktop with no key. Its run computer answers screen.shot (a plain grey screen) and input.actions
//   (each action done, none performed). Its live view is a page serve itself answers on its own address, view-only or
//   driving, so the run's take-over and hand-back have a viewer to open; after the release the page is gone.
import { crc32, deflateSync } from "node:zlib";
import { SETTING_KIND_NAMES, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";
import type { KeyTable, ProviderFactories } from "./computer-keys.js";
import type { ComputerKind } from "./computer-setting.js";
import type { KindCapabilities, KindRegistry, ProviderEntry } from "./computers.js";
import type { ComputerSettingKind, LaunchedComputer } from "./workspace/resolve-computer.js";

// The computer package's own setting kinds and servingRefusals; only the providers are faux.
const KIND_NAMES = SETTING_KIND_NAMES as readonly ComputerKind[];

const SANDBOX = { kind: "linux", groups: ["exec", "files", "processes"] } as unknown as KindCapabilities;
const DESKTOP_GROUPS = ["screen", "input.pointer", "input.keys"] as const;
const DESKTOP = { kind: "desktop", groups: [...DESKTOP_GROUPS] } as unknown as KindCapabilities;

const entry = (fields: Omit<ProviderEntry, "kinds">): ProviderEntry =>
  ({ ...fields, kinds: KIND_NAMES.filter((kind) => fields.capabilities.some((one) => servingRefusals(one, kind).length === 0)) }) as ProviderEntry;

const PROVIDERS: readonly ProviderEntry[] = [
  entry({ id: "faux-sandbox", label: "Faux sandbox", keys: [{ name: "FAUX_SANDBOX_KEY", required: true }], mounts: ["bind"], metered: false, capabilities: [SANDBOX] } as Omit<ProviderEntry, "kinds">),
  entry({ id: "faux-broken", label: "Faux broken", keys: [], mounts: ["bind"], metered: false, capabilities: [SANDBOX] } as Omit<ProviderEntry, "kinds">),
  entry({ id: "faux-desktop", label: "Faux desktop", keys: [], mounts: [], metered: false, capabilities: [DESKTOP] } as Omit<ProviderEntry, "kinds">),
];

const KEYS: KeyTable = {
  keys: { "faux-sandbox": [{ name: "FAUX_SANDBOX_KEY", option: "apiKey", required: true }], "faux-broken": [], "faux-desktop": [] },
  labels: { "faux-sandbox": "Faux sandbox", "faux-broken": "Faux broken", "faux-desktop": "Faux desktop" },
};

/** Each faux provider's account test: faux-sandbox and faux-desktop answer, faux-broken is never reached. */
const FACTORIES: ProviderFactories = {
  "faux-sandbox": () => ({ testConnection: async () => ({ ok: true, value: { detail: "Faux sandbox: the faux account answered (no computer was made)" } }) }),
  "faux-desktop": () => ({ testConnection: async () => ({ ok: true, value: { detail: "Faux desktop: the faux account answered (no computer was made)" } }) }),
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

/** A started faux desktop: the claim's LaunchedComputer, with the provider's live stream of its screen. */
export type FauxDesktop = LaunchedComputer & {
  stream(options: { readonly viewOnly: boolean }): Promise<{ readonly url: string }>;
};

/** The path a faux desktop's live view is served at, on serve's own address: FAUX_VIEW_PATH/<id>/view or /drive. */
export const FAUX_VIEW_PATH = "/faux/desktops";

/** What serve takes in place of the computer package under --faux. */
export interface FauxComputers {
  readonly kinds: KindRegistry;
  readonly factories: ProviderFactories;
  readonly keyTable: KeyTable;
  /** The claim's launch: a faux desktop; the faux sandboxes start nothing, in words. */
  launch(entry: ProviderEntry, spec: { readonly kind: ComputerSettingKind; readonly keys: Readonly<Record<string, string>> }): Promise<FauxDesktop>;
  /** The live view's page for a path under FAUX_VIEW_PATH, for serve to answer; undefined for any other path, or a
   *  desktop that is released or never was. */
  viewPage(pathname: string): string | undefined;
}

/**
 * --faux's computers. `viewerBase` is serve's own address (scheme, host and port), so a faux desktop's live view is a page
 * serve itself answers (viewPage), with no other listener. The server answers FAUX_VIEW_PATH with viewPage only under
 * --faux.
 */
export function fauxComputers({ viewerBase }: { readonly viewerBase: string }): FauxComputers {
  const live = new Set<string>();
  let started = 0;

  /** A faux desktop for a run: screen.shot gives a grey screen, input.actions does each action and performs none, and its
   *  live view is its page on serve, view-only or driving, until the release. */
  function fauxDesktop(): FauxDesktop {
    const id = `faux-desktop-${++started}`;
    const png = greyPng(WIDTH, HEIGHT);
    live.add(id);
    const call = async (method: string, params: Record<string, unknown>) => {
      if (method === "screen.shot") return { ok: true, value: { id: `${id}-shot`, data: png.toString("base64"), eof: true, size: png.length, width: WIDTH, height: HEIGHT } };
      if (method === "input.actions") return { ok: true, value: { done: Array.isArray(params.actions) ? params.actions.length : 0 } };
      return { ok: false, error: { code: "unsupported", message: `the faux desktop has no ${method}` } };
    };
    return {
      id,
      groups: [...DESKTOP_GROUPS],
      client: { call } as unknown as LaunchedComputer["client"],
      stream: async ({ viewOnly }) => ({ url: new URL(`${FAUX_VIEW_PATH}/${id}/${viewOnly ? "view" : "drive"}`, viewerBase).href }),
      release: async () => void live.delete(id),
    };
  }

  return {
    kinds: { SETTING_KINDS, PROVIDERS, servingRefusals },
    factories: FACTORIES,
    keyTable: KEYS,
    async launch(entryOf, spec) {
      if (entryOf.id === "faux-desktop" && spec.kind === "desktop") return fauxDesktop();
      throw new Error(`${entryOf.label} starts no computer: under --faux, only Faux desktop does (set this agent's computer to desktop on Faux desktop, or none)`);
    },
    viewPage(pathname) {
      const match = new RegExp(`^${FAUX_VIEW_PATH}/(faux-desktop-\\d+)/(view|drive)$`).exec(pathname);
      if (!match || !live.has(match[1]!)) return undefined;
      const driving = match[2] === "drive";
      return `<!doctype html><meta charset="utf-8"><title>Faux desktop ${match[1]}</title><body style="background:#c0c0c0;font:16px sans-serif"><p>Faux desktop ${match[1]}: ${driving ? "driving (taken over)" : "watching (view only)"}</p></body>`;
    },
  };
}
