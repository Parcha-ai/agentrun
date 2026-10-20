// Where the threads' sandboxes come from. One function, `boxProviders`, is the seam: the session asks it for the providers
// pi-transport's config names, and gets Modal's (made with the Modal client the VM's own token opens) in a live run, or a stand-in that
// runs local boxes and writes down what each box was asked to be, offline. No `local` provider is ever returned: an environment
// served by the host's own machine is exactly what this example keeps the agent away from.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { localBoxes } from "@parcha/pi-transport/box/local";
import type { BoxProvider } from "@parcha/pi-transport";

/** What a box was asked to be and what became of it, one JSON line each (the offline tests read it). */
export type BoxEvent = { ev: "create" | "destroy"; id?: string; spec?: Record<string, unknown> };

export function fakeModalBoxes(root: string, ledger: string): BoxProvider {
  mkdirSync(root, { recursive: true });
  const inner = localBoxes({ root });
  const note = (event: BoxEvent) => appendFileSync(ledger, `${JSON.stringify(event)}\n`);
  return {
    ...inner,
    name: "modal",
    async create(spec, context) {
      const { image, snapshot, cpus, memoryMb, gpu, region, isolation, ...plain } = spec;
      const made = await inner.create(plain, context);
      if (!made.ok) return made;
      note({ ev: "create", id: made.value.id, spec: { image, gpu, isolation, labels: spec.labels, maxLifetimeMs: spec.maxLifetimeMs } });
      const box = made.value;
      return {
        ok: true,
        value: new Proxy(box, {
          get(target, prop) {
            if (prop === "destroy") return async (context2: never) => (note({ ev: "destroy", id: box.id }), box.destroy(context2));
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
    },
  };
}

/** Modal's sandboxes, through the Modal client the process's own MODAL_TOKEN_ID and MODAL_TOKEN_SECRET open. Live only. */
export async function modalProvider(appName: string, tokenId: string, tokenSecret: string): Promise<BoxProvider> {
  const { ModalClient } = (await import("modal" as string)) as { ModalClient: new (options?: unknown) => unknown };
  const { modalBoxes } = await import("@parcha/pi-transport/box/modal");
  // The token is handed to the client by value and read from nowhere else: the caller has already removed it from `process.env`.
  return modalBoxes(new ModalClient({ tokenId, tokenSecret }) as never, { appName });
}

export const ledgerPath = (dir: string) => join(dir, "boxes.jsonl");
