// The creature the user drew, known to the server: when the tab's two creature files (creature.xml, body.json) have stopped changing
// for `delayMs`, the box that will train it is told to compile for it, once per distinct drawing. The tab saves a few seconds after
// the last stroke and rewrites both files for every design, so waiting out the writes warms the final shape and not each step of the
// drawing. The warm-up never delays a switch (warm-train.ts); this only decides when it starts.
import { createHash } from "node:crypto";

export const CREATURE_FILES = ["creature/creature.xml", "creature/body.json"] as const;

export interface CreatureWarmer {
  /** A tab write of `path` (any path; only the creature's two files count). */
  write(path: string, data: Uint8Array): void;
  close(): void;
}

export function creatureWarmer(options: { delayMs: number; warm(creature: { xml: Uint8Array; body: Uint8Array }): Promise<unknown>; log?: (event: string, data?: Record<string, unknown>) => void }): CreatureWarmer {
  const log = options.log ?? (() => {});
  const files = new Map<string, Uint8Array>();
  let timer: NodeJS.Timeout | undefined;
  let warmed = "";
  return {
    write(path, data) {
      if (!(CREATURE_FILES as readonly string[]).includes(path)) return;
      files.set(path, data);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const xml = files.get(CREATURE_FILES[0]);
        const body = files.get(CREATURE_FILES[1]);
        if (!xml || !body) return;
        const id = createHash("sha256").update(xml).update(body).digest("hex");
        if (id === warmed) return;
        warmed = id;
        log("warm.creature", { creature: id.slice(0, 12) });
        void options.warm({ xml, body }).catch((error: Error) => log("warm.failed", { error: error.message }));
      }, options.delayMs);
      timer.unref();
    },
    close() {
      clearTimeout(timer);
    },
  };
}
