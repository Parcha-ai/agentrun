// The server's tool settings over the one store (store.settings): a synchronous get() off an in-memory snapshot the server
// (the one writer of this row) loads once at start and keeps in step with every put(), and a put() that returns the
// settings as served, durable before the handler's answer. The read and write go through loadToolSettings /
// saveToolSettings; this layer is only the snapshot and the sync surface.
import { SETTINGS_UNREAD } from "./tool-gate.js";
import { loadToolSettings, saveToolSettings, type ToolSettingsMap } from "./tool-plane.js";
import type { Settings } from "./store/index.js";

/** The store slice this layer needs: the settings row, and a flush so a put is durable before it resolves. */
type ToolSettingsStore = { readonly settings: Pick<Settings, "get" | "put">; flush(): Promise<void> };

class ToolSettingsOverStore {
  private current: ToolSettingsMap = {};
  /** The row was present but did not read at the start: every tool takes its defaults until a PUT replaces it. */
  private unread = false;

  constructor(private readonly store: ToolSettingsStore, private readonly warn: (line: string) => void) {}

  /** Reads the store row once into the snapshot, warning on each problem as the ToolSettings constructor did (a stored
   *  permission that is not offered is a marked stand-in; an unreadable row is every default). Awaited once at start. */
  async load(): Promise<void> {
    const { settings, problems, unreadable } = await loadToolSettings(this.store);
    for (const line of problems) this.warn(`agentrun-serve: ${line}; ${unreadable ? "every tool takes its defaults" : "that entry is dropped (a permission that is not offered reads ask)"} until a PUT /v2/settings/tools`);
    this.current = settings;
    this.unread = unreadable === true;
  }

  /** The settings as served, a copy, off the snapshot. Synchronous, as the server's recompose, blockers and agent reads
   *  take it. While the row does not read, the map carries SETTINGS_UNREAD (tool-gate.ts), as ToolSettings.get does for
   *  the file: a copy drops the symbol, so it is set on the copy, and approvals "never" lifts no ask over a deny the row
   *  may hold. */
  get(): ToolSettingsMap {
    const map = structuredClone(this.current);
    if (this.unread) (map as { [SETTINGS_UNREAD]?: true })[SETTINGS_UNREAD] = true;
    return map;
  }

  /** Replaces the settings in the store and the snapshot: a tool `map` leaves out takes its defaults; a fail-closed
   *  stand-in sent back unchanged stays a stand-in. Durable before it resolves. Answers the settings as served. */
  async put(map: ToolSettingsMap): Promise<ToolSettingsMap> {
    const served = await saveToolSettings(this.store, map);
    await this.store.flush();
    this.current = served;
    // The row is the one just written: it reads.
    this.unread = false;
    return this.get();
  }
}

export type { ToolSettingsOverStore };

/** The ToolSettings surface over the one store: the switch swaps `new ToolSettings(dir)` for this, then awaits load() once
 *  at start before the first get(). */
export function toolSettingsOverStore(store: ToolSettingsStore, warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`)): ToolSettingsOverStore {
  return new ToolSettingsOverStore(store, warn);
}
