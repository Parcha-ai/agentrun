// Split adapters: the base GGUF stays cached in the tab, and a skill or an obsession comes home as a LoRA adapter of a few tens of MB instead
// of a merged model of 806 MB. wllama 3.6.1 applies LoRA adapters (`lora_adapters` at load, and `lora: [{id, scale}]` on each request, which
// passes through to llama.cpp's server). Measured in real Chrome: at scale 0 the output is token-identical to the base, at scale 1 to the
// adapter loaded alone, two adapters over one base are picked independently per request, and nothing reloads.
// What wllama lacks is a way to put an adapter FILE into its in-memory filesystem: loadModel sends every blob it is given as a model shard.
// `loadWithAdapters` wraps the worker proxy's moduleInit (the proxy is created inside loadModel) so the adapter blobs are added as
// /models/<name>, which `lora_adapters` then names. That reaches into wllama's internals, so the version is pinned (the package and the
// llama.cpp build in it) and checked before anything loads, and a load in which the hook never ran is refused.
// Two measured costs: a request whose selection differs from the previous one drops the prompt cache (the whole conversation prefills
// again), so switch at handoffs, not per turn; and decoding is about 5% slower with an adapter applied.

import wllamaPackage from '@wllama/wllama/package.json' with { type: 'json' };
import { Wllama } from '@wllama/wllama/esm/index.js';
import { WLLAMA_FILE_NAMES } from './adapter-manifest.ts';

export const PINNED_WLLAMA = '3.6.1';
export const PINNED_LIBLLAMA = 'b10663-83d855c';

export class AdapterError extends Error {}

export interface WllamaVersions { wllama: string; libllama: string }
export const installedVersions = (): WllamaVersions => ({ wllama: wllamaPackage.version, libllama: Wllama.getLibllamaVersion() });

/** Refuse anything but the pinned wllama: the adapter hook reaches into its internals. */
export function assertPinnedWllama(v: WllamaVersions = installedVersions()): void {
  if (v.wllama === PINNED_WLLAMA && v.libllama === PINNED_LIBLLAMA) return;
  throw new AdapterError(
    `wllama ${v.wllama} (llama.cpp ${v.libllama}) is not the pinned ${PINNED_WLLAMA} (${PINNED_LIBLLAMA}). The adapter loader wraps ` +
      `wllama's internal worker proxy (proxy.moduleInit), so before the pin moves, check that hook again and measure parity and switching again.`,
  );
}

/** An adapter file to load beside the base. `name` is its file name in wllama's filesystem and its key in a selection. */
export interface AdapterFile { name: string; blob: Blob }

/** One safe file name; wllama's own names (WLLAMA_FILE_NAMES, shared with the manifest parser) are never taken. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.gguf$/;

/** The `lora` field of one createChatCompletion request: every loaded adapter, by id, with its scale. */
export type LoraSelection = { id: number; scale: number }[];

/** The largest scale a request may ask for. Adapters are trained to run at 1; the cap stops a typo from wrecking the output. */
export const MAX_SCALE = 4;

export interface LoadedAdapters {
  /** Adapter names in load order: the index is the id llama.cpp knows each one by. */
  readonly names: readonly string[];
  /** The selection for one request: the named adapters at their scales, every other one at 0. */
  select(scales: Readonly<Record<string, number>>): LoraSelection;
}

/** The part of a Wllama instance the loader uses (an interface, so a test can pass a fake). */
export interface WllamaLike { loadModel(blobs: Blob[], params?: Record<string, unknown>): Promise<void> }
type ModelFile = { name: string; blob: Blob };
type ProxyLike = { moduleInit(files: ModelFile[]): Promise<unknown> };

/** A selection over `names`; an unknown name or a scale outside 0..MAX_SCALE is refused. */
export function selection(names: readonly string[], scales: Readonly<Record<string, number>>): LoraSelection {
  for (const [name, scale] of Object.entries(scales)) {
    if (!names.includes(name)) throw new AdapterError(`no adapter named ${JSON.stringify(name)} is loaded (loaded: ${names.join(', ') || 'none'})`);
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0 || scale > MAX_SCALE) throw new AdapterError(`scale ${scale} for ${name} is outside 0..${MAX_SCALE}`);
  }
  return names.map((name, id) => ({ id, scale: scales[name] ?? 0 }));
}

/**
 * Load the base (its blobs, as wllama's loadModel takes them) and every adapter beside it at scale 0, so a request without a selection is
 * the base. `params` are wllama's load parameters (`lora_adapters` is set here and refused in `params`). Returns the adapter names in id
 * order and a `select` that builds each request's `lora` field.
 */
export async function loadWithAdapters(
  w: WllamaLike,
  base: Blob[],
  adapters: AdapterFile[],
  params: Record<string, unknown> = {},
  versions: WllamaVersions = installedVersions(),
): Promise<LoadedAdapters> {
  assertPinnedWllama(versions);
  if ('lora_adapters' in params) throw new AdapterError('pass the adapters as AdapterFiles, not as lora_adapters: the loader puts their files in place and sets the paths');
  const seen = new Set<string>();
  for (const a of adapters) {
    if (!NAME.test(a.name) || WLLAMA_FILE_NAMES.test(a.name)) throw new AdapterError(`adapter name ${JSON.stringify(a.name)} is not a safe .gguf file name of its own`);
    if (seen.has(a.name)) throw new AdapterError(`adapter ${a.name} is listed twice`);
    if (!(a.blob instanceof Blob) || a.blob.size === 0) throw new AdapterError(`adapter ${a.name} has no bytes`);
    seen.add(a.name);
  }
  const names = adapters.map((a) => a.name);
  if (adapters.length === 0) {
    await w.loadModel(base, params);
    return { names, select: (scales) => selection(names, scales) };
  }

  const target = w as WllamaLike & { proxy?: unknown };
  let proxy: unknown = target.proxy;
  let hooked = false;
  Object.defineProperty(target, 'proxy', {
    configurable: true,
    enumerable: true,
    get: () => proxy,
    set: (next: unknown) => {
      const p = next as ProxyLike | null;
      if (p && typeof p.moduleInit === 'function' && !hooked) {
        const init = p.moduleInit.bind(p);
        p.moduleInit = (files: ModelFile[]) => init([...files, ...adapters.map((a) => ({ name: a.name, blob: a.blob }))]);
        hooked = true;
      }
      proxy = next;
    },
  });
  try {
    await w.loadModel(base, { ...params, lora_adapters: names.map((name) => ({ path: `models/${name}`, scale: 0 })) });
  } catch (e) {
    if (!hooked) throw new AdapterError('wllama never set its worker proxy through the adapter hook (its internals changed), so the adapter files were not in its filesystem', { cause: e });
    throw e;
  } finally {
    Object.defineProperty(target, 'proxy', { configurable: true, enumerable: true, writable: true, value: proxy });
  }
  if (!hooked) throw new AdapterError('wllama loaded without setting its worker proxy through the adapter hook (its internals changed): the adapters are not loaded');
  return { names, select: (scales) => selection(names, scales) };
}
