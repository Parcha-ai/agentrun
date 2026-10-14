// The 03 server's argv for the GG page (show/scripts/take-server.mjs), apart from the launcher so a test reads it: this
// page's own port, run, mount root and Modal app; the GG extra on the VM; Jev's placer; the tab's root instructions and the
// extensions it goes without (serve.ts --instructions-file ...).
import { GG_INSTRUCTIONS, GG_WITHOUT_IN_TAB } from "./gg-text.ts";
import { STEER_INSTRUCTIONS } from "./steer-text.ts";

/** Each page the launcher starts, and its own places: its state and logs under the home directory, its Modal app (the
 * GPU box and the VM), its run, mount root and port, its extra (the bundle `npm run bundle:extra` writes) and the root
 * conversation's instructions. The Golden Gate page is the default; `--page any` is the page where the person names the
 * topic. */
export interface PageProfile {
  /** Under the user's home directory. */
  readonly home: string;
  readonly app: string;
  readonly run: string;
  readonly mountRoot: string;
  readonly port: string;
  /** The bundled extra in dist/, without its extension. */
  readonly extra: string;
  readonly instructions: string;
}

export const PAGES: Readonly<Record<string, PageProfile>> = {
  "golden-gate": { home: "tmp-gg-chat", app: "pda-gg-chat", run: "golden-gate", mountRoot: "/mnt/pda/demo/gg-chat-pipe", port: "8773", extra: "gg-extra", instructions: GG_INSTRUCTIONS },
  any: { home: "tmp-steer", app: "pda-steer", run: "steer-any", mountRoot: "/mnt/pda/demo/steer-any", port: "8783", extra: "steer-extra", instructions: STEER_INSTRUCTIONS },
};

export function pageProfile(name: string | undefined): PageProfile {
  const page = PAGES[name ?? "golden-gate"];
  if (!page) throw new Error(`--page ${name}: one of ${Object.keys(PAGES).join(", ")}`);
  return page;
}

/** The page's base agent: Opus 5.5 through the broker on this host (its dotted id), unless the take names another. */
export const DEFAULT_AGENT_MODEL = "claude-opus-5.5";

/** What the GPU box's processes get from the take: the guard's best-of-N on pushback turns only when the take sets it. */
export function boxEnv(o: { bestOf?: string }): Record<string, string> {
  if (o.bestOf === undefined) return {};
  if (!/^[1-9][0-9]?$/.test(o.bestOf)) throw new Error(`--best-of ${o.bestOf}: a number of draws, 1-99`);
  return { GG_BEST_OF: o.bestOf };
}

export interface ServerPlaces {
  takeServer: string;
  mountRoot: string;
  serverDir: string;
  run: string;
  port: string;
  agentModel: string;
  cloudModule: string;
  app: string;
  extraModule: string;
  secrets: string;
  placer: string;
  instructions: string;
}

export function serverArgs(p: ServerPlaces): string[] {
  return [
    p.takeServer,
    "--mount-root", p.mountRoot,
    "--dir", p.serverDir,
    "--run", p.run,
    "--port", p.port,
    "--budget", "3000000",
    "--agent-model", p.agentModel,
    "--grace-ms", "180000",
    "--up-timeout-s", "150",
    "--modal",
    "--typesafe",
    "--cloud-module", p.cloudModule,
    "--cloud-arg", "regions=us-east",
    "--cloud-arg", `app=${p.app}`,
    "--cloud-arg", `prefix=${p.app}-`,
    "--cloud-arg", `extra-module=${p.extraModule}`,
    "--cloud-arg", `extra-secrets=${p.secrets}`,
    "--cloud-arg", "robot-code=false",
    "--placer-module", p.placer,
    "--placer-arg", "client=jev",
    "--instructions-file", p.instructions,
    "--instructions-mode", "replace",
    "--without-extensions", GG_WITHOUT_IN_TAB.join(","),
  ];
}

/** The link the person opens: the thinking open and dimmed as it streams, and no robot starter files from the tab (the
 * page is not about the robot; the VM gets robot-code=false on its own). The fragment is the run's secret. */
export function pageLink(base: string, secret: string): string {
  const url = new URL(base);
  url.searchParams.set("thinking", "open");
  url.searchParams.set("robotcode", "0");
  return `${url.toString()}#${secret}`;
}
