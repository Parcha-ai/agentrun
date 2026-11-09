// The server's tool settings over the one store (store.settings), the store-backed replacement for the ToolSettings class
// (tool-plane.ts) that read and wrote tool-settings.json. It keeps the same surface the server calls: a synchronous get()
// off an in-memory snapshot the server (the one writer of this row) loads once at start and keeps in step with every
// put(), and a put() that returns the settings as served. put() returns a promise the handler awaits (durable before the
// 204, as writeDurableSync was). The read and write go through loadToolSettings / saveToolSettings; this layer is
// only the snapshot and the sync surface the switch swaps `new ToolSettings(dir)` for.
import { loadToolSettings, saveToolSettings, type ToolSettingsMap } from "./tool-plane.js";
import type { Settings } from "./store/index.js";

/** The store slice this layer needs: the settings row, and a flush so a put is durable before it resolves. */
type ToolSettingsStore = { readonly settings: Pick<Settings, "get" | "put">; flush(): Promise<void> };

class ToolSettingsOverStore {
  private current: ToolSettingsMap = {};

  constructor(private readonly store: ToolSettingsStore, private readonly warn: (line: string) => void) {}

  /** Reads the store row once into the snapshot, warning on each problem as the ToolSettings constructor did (a stored
   *  permission that is not offered is a marked stand-in; an unreadable row is every default). Awaited once at start. */
  async load(): Promise<void> {
    const { settings, problems, unreadable } = await loadToolSettings(this.store);
    for (const line of problems) this.warn(`agentrun-serve: ${line}; ${unreadable ? "every tool takes its defaults" : "that entry is dropped (a permission that is not offered reads ask)"} until a PUT /v2/settings/tools`);
    this.current = settings;
  }

  /** The settings as served, a copy, off the snapshot. Synchronous, as the server's recompose, blockers and agent reads
   *  take it. */
  get(): ToolSettingsMap {
    return structuredClone(this.current);
  }

  /** Replaces the settings in the store and the snapshot: a tool `map` leaves out takes its defaults; a fail-closed
   *  stand-in sent back unchanged stays a stand-in. Durable before it resolves. Answers the settings as served. */
  async put(map: ToolSettingsMap): Promise<ToolSettingsMap> {
    const served = await saveToolSettings(this.store, map);
    await this.store.flush();
    this.current = served;
    return this.get();
  }
}

export type { ToolSettingsOverStore };

/** The ToolSettings surface over the one store: the switch swaps `new ToolSettings(dir)` for this, then awaits load() once
 *  at start before the first get(). */
export function toolSettingsOverStore(store: ToolSettingsStore, warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)): ToolSettingsOverStore {
  return new ToolSettingsOverStore(store, warn);
}
