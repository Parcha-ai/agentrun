// Where the threads' sandboxes come from. The session asks for a provider and gets Modal's (made with the Modal client the VM's own token opens) in a
// live run, or a stand-in that runs local boxes offline. Either way each box's creation and destruction is written down in a ledger beside the run's
// workspace (never in the recording), so a run can say how many distinct sandboxes it had and that each ended. No `local` provider is ever returned: an
// environment served by the host's own machine is exactly what this example keeps the agent away from.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { localBoxes } from "@parcha/pi-transport/box/local";
import type { Box, BoxProvider } from "@parcha/pi-transport";

/** What a box was asked to be and what became of it, one JSON line each. */
export type BoxEvent = { ev: "create" | "destroy"; id?: string; spec?: Record<string, unknown>; at?: string };

/** The part of a box spec the ledger keeps. */
const asked = (spec: Record<string, unknown>) => ({ image: spec.image, gpu: spec.gpu, isolation: spec.isolation, labels: spec.labels, maxLifetimeMs: spec.maxLifetimeMs });

/** `box`, with its creation (as asked for in `spec`) and its destruction written to `ledger`. */
function watched(box: Box, spec: Record<string, unknown>, ledger: string): Box {
  const note = (event: BoxEvent) => appendFileSync(ledger, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
  note({ ev: "create", id: box.id, spec: asked(spec) });
  return new Proxy(box, {
    get(target, prop) {
      if (prop === "destroy") return async (context: never) => (note({ ev: "destroy", id: box.id }), box.destroy(context));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A provider that writes each box it makes, and each it ends, to `ledger`. */
export function ledgered(inner: BoxProvider, ledger: string): BoxProvider {
  mkdirSync(dirname(ledger), { recursive: true });
  return {
    ...inner,
    async create(spec, context) {
      const made = await inner.create(spec, context);
      return made.ok ? { ok: true, value: watched(made.value, spec as Record<string, unknown>, ledger) } : made;
    },
  };
}

export function fakeModalBoxes(root: string, ledger: string): BoxProvider {
  mkdirSync(root, { recursive: true });
  mkdirSync(dirname(ledger), { recursive: true });
  // The stand-in's boxes find this Node by name, so a command in the recording says `node`, not where it is installed.
  const inner = localBoxes({ root, path: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin` });
  return {
    ...inner,
    name: "modal",
    async create(spec, context) {
      // The stand-in cannot honour a GPU, an image or an isolation; the ledger still names what the box was asked to be.
      const { image, snapshot, cpus, memoryMb, gpu, region, isolation, ...plain } = spec;
      const made = await inner.create(plain, context);
      return made.ok ? { ok: true, value: watched(made.value, spec as Record<string, unknown>, ledger) } : made;
    },
  };
}

/** Modal's sandboxes, through the Modal client the given token opens, each one written to `ledger`. Live only. */
export async function modalProvider(appName: string, tokenId: string, tokenSecret: string, ledger: string): Promise<BoxProvider> {
  const { ModalClient } = (await import("modal" as string)) as { ModalClient: new (options?: unknown) => unknown };
  const { modalBoxes } = await import("@parcha/pi-transport/box/modal");
  // The token is handed to the client by value and read from nowhere else: the caller has already removed it from `process.env`.
  return ledgered(modalBoxes(new ModalClient({ tokenId, tokenSecret }) as never, { appName }), ledger);
}

export const ledgerPath = (dir: string) => join(dir, "boxes.jsonl");
