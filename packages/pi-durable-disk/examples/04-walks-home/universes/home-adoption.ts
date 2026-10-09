// The winner's move home, on this side: the tab's server (03-tab-to-cloud serve.ts, --admin-token-file) is asked to adopt
// the sealed winner by run id, and the policy the tab loads is chosen (home-policy.ts). From the moment the attach is
// asked, the tab's server may hold the run: cleanup never deletes a run that is `handed`, waits for an adoption in
// flight before it deletes any run, and once it began no adoption starts. The server's answer is the run's link, with
// the run's secret: it goes to the loopback route (GET /api/home), never to a note or a log.
import { readFileSync } from "node:fs";
import type { RunRef } from "@parcha/pi-durable-disk";

export type Home = { readonly run: string; readonly url: string; readonly policy: string | null };

export interface HomeAdoptionOptions {
  /** The tab's server, e.g. http://127.0.0.1:38979; with `tokenFile`, or there is no adoption. */
  readonly server?: string;
  /** Its admin token's file (0600); read at each adoption, never logged. */
  readonly tokenFile?: string;
  /** The policy file under work/ the tab loads, or null when none may go home. */
  policy(run: RunRef, universe: string): Promise<string | null>;
  /** The policy could not be chosen: nothing goes home, and the stage is told. */
  onPolicyFailed(run: RunRef, error: Error): void;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
  readonly fetch?: typeof fetch;
  readonly attachTimeoutMs?: number;
  /** How long `close` waits for an adoption in flight, its policy reads included. Default 30 s. */
  readonly closeTimeoutMs?: number;
}

export interface HomeAdoption {
  /** For mv.home's onSealed: adopt the sealed winner. */
  adopt(run: RunRef, universe: string): Promise<void>;
  /** What GET /api/home answers: set once the run is adopted and its policy chosen. */
  readonly home: Home | undefined;
  /** The run the tab's server holds or may hold: cleanup keeps it. */
  readonly handed: string | undefined;
  /**
   * Cleanup begins: no adoption starts from now on, and this resolves when the one in flight ended, or at
   * `closeTimeoutMs`. A run asked for stays `handed` either way, so cleanup keeps it.
   */
  close(): Promise<void>;
}

export function homeAdoption(o: HomeAdoptionOptions): HomeAdoption {
  let home: Home | undefined;
  let handed: string | undefined;
  let adopting: Promise<void> | undefined;
  let closed = false;
  return {
    get home() {
      return home;
    },
    get handed() {
      return handed;
    },
    adopt(run, universe) {
      if (!o.server || !o.tokenFile) return Promise.resolve();
      // Once cleanup began, the winner stays sealed on the disk: an adoption now could hand over a run being deleted.
      if (closed) return Promise.reject(new Error(`cleaning up: ${run.id} stays sealed on the disk`));
      adopting = (async () => {
        const token = readFileSync(o.tokenFile!, "utf8").trim();
        handed = run.id;
        const res = await (o.fetch ?? fetch)(`${o.server}/api/runs/${encodeURIComponent(run.id)}/attach`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(o.attachTimeoutMs ?? 30_000),
        });
        const body = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
        if (!res.ok || !body.link) {
          // The server answered no: the run is still ours. A request that got no answer leaves it handed.
          if (!res.ok) handed = undefined;
          throw new Error(`the tab's server did not adopt ${run.id}: ${res.status} ${body.error ?? ""}`);
        }
        o.log("home.adopted", { run: run.id, status: res.status });
        const policy = await o.policy(run, universe).catch((error: unknown) => {
          o.onPolicyFailed(run, error as Error);
          return null;
        });
        home = { run: run.id, url: `${o.server}${body.link}`, policy };
      })();
      return adopting;
    },
    async close() {
      closed = true;
      if (!adopting) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, o.closeTimeoutMs ?? 30_000)));
      await Promise.race([adopting.catch(() => undefined), deadline]);
      clearTimeout(timer);
    },
  };
}
