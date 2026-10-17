import type { ToolContract } from "./contract.js";
import type { ToolOutput } from "./custody.js";
import type { BrowserFailure } from "./failures.js";
import type { ChildRunner, SiteInfo, SiteRunPort } from "./host.js";

export const MAX_SITE_INSTRUCTIONS = 16_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const RUN_STATE = /^[a-z_]{1,40}$/;

/** The site enum and the description render from the listing, which is configuration: every request sends the same
 *  text and keeps the prompt cache. */
export function useWebsiteContract(sites: readonly SiteInfo[]): ToolContract {
  return {
    name: "use_website",
    label: "Use a website",
    description: [
      "Hand a task to an agent that works on one of these websites in its own browser, and get back what it found or did:",
      ...sites.map((site) => `- ${site.site}: ${site.title}. ${site.description}`),
      "Give a new request_id (a UUID) for each new task. Calling again with the request_id of a finished task answers its result without running it again; a task that failed runs again, and may repeat what it already did on the site.",
      "Several calls in one turn run at once, each agent in its own browser.",
    ].join("\n"),
    parameters: {
      type: "object", additionalProperties: false, required: ["site", "request_id", "instructions"],
      properties: {
        site: { type: "string", enum: sites.map((site) => site.site), description: "The website to use." },
        request_id: { type: "string", description: "A UUID you choose for this task." },
        instructions: { type: "string", maxLength: MAX_SITE_INSTRUCTIONS, description: "What to do on the website and what to report back." },
      },
    },
    effect: "effect", replay: "safe", executionMode: "parallel", evidence: "none", listedWhen: "sites",
  };
}

/** Only the declared shape crosses back to the model: a port's extra fields, such as capabilities or URLs, are dropped
 *  here, and an answer with both shapes or neither is no answer. */
export function siteAnswer(raw: unknown): { run: { id: string; state: string } } | { report: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { run, report } = raw as { run?: unknown; report?: unknown };
  if ((run === undefined) === (report === undefined)) return null;
  if (report !== undefined) return typeof report === "string" ? { report } : null;
  const { id, state } = (run ?? {}) as { id?: unknown; state?: unknown };
  return typeof id === "string" && RUN_ID.test(id) && typeof state === "string" && RUN_STATE.test(state) ? { run: { id, state } } : null;
}

const siteOutput = (body: object, isError = false): ToolOutput => ({ content: [{ type: "text", text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}) });
const siteRefusal = (message: string) => siteOutput({ ok: false, code: "refused", retryable: false, effect: "none", message } satisfies BrowserFailure, true);

export async function useWebsite(args: { site?: unknown; request_id?: unknown; instructions?: unknown }, port: SiteRunPort, sites: readonly SiteInfo[], ctx: { signal: AbortSignal; runChild: ChildRunner }): Promise<ToolOutput> {
  const site = sites.find((known) => known.site === args.site);
  if (!site) return siteRefusal(`site is one of: ${sites.map((known) => known.site).join(", ")}`);
  if (typeof args.request_id !== "string" || !UUID.test(args.request_id)) return siteRefusal("request_id is a UUID you choose for this task");
  const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
  if (!instructions || instructions.length > MAX_SITE_INSTRUCTIONS) return siteRefusal(`instructions say what to do on the site, in at most ${MAX_SITE_INSTRUCTIONS} characters`);
  const head = { ok: true, site: site.site, request_id: args.request_id };
  let raw: unknown;
  try {
    raw = await port.use({ site: site.site, requestId: args.request_id, instructions }, ctx);
  } catch {
    // A port's error text can carry its grant or a URL: none of it is forwarded.
    if (ctx.signal.aborted) return siteOutput({ ok: false, code: "aborted", retryable: true, effect: "possibly_effected", message: "The call was cancelled, and the site's task may already have changed the site. Calling again with the same request_id runs an unfinished task again, and it may repeat what it did." }, true);
    return siteOutput({ ok: false, code: "command_failed", retryable: true, effect: "possibly_effected", message: `The ${site.site} task failed, and may already have changed the site. Calling use_website again with the same request_id runs it again, and it may repeat what it did.` }, true);
  }
  const parsed = siteAnswer(raw);
  if (!parsed) return siteOutput({ ok: false, code: "command_failed", retryable: false, effect: "possibly_effected", message: `The ${site.site} runner answered neither a started task nor a report.` }, true);
  if ("report" in parsed) return siteOutput({ ...head, report: parsed.report });
  return siteOutput({ ...head, run: parsed.run, next: "The site's task was started; its result arrives through your host. Do not call use_website again for this request." });
}

export type LocalSite = { title: string; description: string; startUrl: string };

const childPrompt = (site: string, entry: LocalSite, instructions: string) => [
  `You are doing one task on ${entry.title} (${site}) for another agent, in your own browser.`,
  `Start at ${entry.startUrl}.`,
  `Task: ${instructions}`,
  "Use the browser tools. Do not ask questions. Finish with a short report of what you found or did.",
].join("\n");

/** `use_website` for a plain pi user: each task runs a child agent through the adapter's `runChild` and answers its
 *  report. A request_id runs once; a failed run may be asked again. */
export function localSites(sites: Record<string, LocalSite>): SiteRunPort {
  for (const [site, entry] of Object.entries(sites)) {
    if (!/^https?:\/\//.test(entry.startUrl)) throw new Error(`site ${site}: startUrl must be an http or https URL`);
  }
  const runs = new Map<string, Promise<string>>();
  return {
    async list(): Promise<SiteInfo[]> {
      return Object.entries(sites).map(([site, entry]) => ({ site, title: entry.title, description: entry.description }));
    },
    async use({ site, requestId, instructions }, { signal, runChild }) {
      const entry = Object.hasOwn(sites, site) ? sites[site] : undefined;
      if (!entry) throw new Error(`no site named ${site}`);
      const key = `${site}\u0000${requestId}`;
      let run = runs.get(key);
      if (!run) {
        run = runChild({ site, requestId, prompt: childPrompt(site, entry, instructions) }, signal);
        runs.set(key, run);
        run.catch(() => { if (runs.get(key) === run) runs.delete(key); });
      }
      return { report: await run };
    },
  };
}
