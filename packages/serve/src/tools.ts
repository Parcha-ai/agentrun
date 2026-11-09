// The tools a revision may name here: one closed table. Each entry is how the run's process binds the name and which
// environment variables it needs. A name outside the table cannot be named, and nothing is loaded from anywhere else.
// The file tools and `bash` bind from the run's coding source (coding-tools.ts): on the runner, pi's coding tools
// without `bash`, so a run gets no shell on this machine; in a box, pi's four and the background tools (bash_background,
// bash_output, bash_input, bash_signal, bash_list), each call made in the box. `bash` and the background tools may be
// named only by an agent whose place is a box (runnable.ts).
import { blurbOf } from "./tool-blurbs.js";
import type { TSchema } from "typebox";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineExtension, defineTool, type Extension, type Harness, ROOT_CONVERSATION_ID, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { AppContext } from "@parcha/pi-durable-disk";
import type { Revision } from "@parcha/pi-durable-agent";
import { BACKGROUND_LOG_BYTES, BACKGROUND_MAX, BACKGROUND_PAGE_BYTES } from "./background.js";
import type { CodingSource } from "./coding-tools.js";
import { isWorkspaceError, localWorkspace, type Workspace } from "./workspace/index.js";
import { fetchOptions, HTML_READ_CHARS, TEXT_CAP } from "./web-fetch-direct.js";
import { DEFAULT_HARNESS, HARNESSES } from "./harness.js";
import { REPLAY } from "./host-tools.js";
import { type Complete, LLM_TOOL } from "./llm.js";
import { DOCUMENTS_ENV, PDF_PAGES_TOOL, pdfPages } from "./pdf-pages.js";
import { monidTool } from "./monid.js";
import { FAUX_ENV, workflowNodes } from "./model.js";
import { bookedIn, booking, type Ledger } from "./paid-calls.js";
import { browserPrice, browserSpend } from "./browser-cost.js";
import { forModel } from "./result.js";
import { fetchFor, runPages, WEB_FETCH_TOOL, webFetchTool } from "./web-fetch.js";
import { searchFor, WEB_SEARCH_TOOL, webSearchTool } from "./web-search.js";
import { browserNeeds, explainsView, isUnavailable, NO_PARALLEL_KEY, type Pickable, PICKABLE, planeOf, type Plane, PROVIDERS, serverGate, type Tooling, type ToolSettingsMap, whyUnavailable, withDefaults } from "./tool-plane.js";
import type { DenyFrom, SettingFrom } from "./tool-gate.js";
import { PARALLEL_KEY_ENV } from "./decisions.js";
import { keyNeeded } from "./key-words.js";
import { handedSignIn, hostSecrets } from "./secrets.js";
import { redactedAnswer } from "./key-refusal.js";
import { SIGN_IN_KEY, SIGN_IN_SAVED } from "./sign-ins.js";
import { answerIn } from "./runner/hand-back.js";
import type { LiveHandover, LiveViewerStore } from "./browser-live.js";
import type { Claim } from "./store/store.js";

export const ASK_TOOL = "ask_person";
/** Under `--faux` only: a module whose default export gives the browser's `{ provider, driver }` for the run's
 *  environment, the vendor its plane names (`browserbase`, `kernel`) and the saved sign-in it was handed for that
 *  vendor (`{ provider, ref, save }`, or undefined), in place of that vendor's (the tests' fake backend). */
export const FAUX_BROWSER_ENV = "AGENTRUN_SERVE_FAUX_BROWSER";

/** What the result of `ask_person` says; the person's page shows the question as a waiting row. */
export const asked = (question: string) => `Asked the person: ${question.slice(0, 500)}. Waiting for their answer.`;

export const askPerson = defineTool({
  name: ASK_TOOL,
  description: "Ask the person who started this run a question you cannot answer yourself. Call it alone. It ends your turn; the person's reply comes as their next message.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { question: { type: "string", minLength: 1, description: "The question, in one or two plain sentences." } },
    required: ["question"],
  } as unknown as TSchema,
  replay: "safe",
  execute: async (args) => {
    const { question } = args as { question: string };
    return forModel(asked(question), { details: { question }, control: { terminate: true } });
  },
});

/** What a tool's binding gets from the run's process. */
export type ToolHost = {
  where: AppContext;
  /** The run's environment: the server's, without the server's token. */
  env: NodeJS.ProcessEnv;
  /** The run's coding tools, by its place (coding-tools.ts codingSource). */
  coding: CodingSource;
  /** Installs an extension in the run's registry, before the run opens. */
  install(extension: Extension): void;
  /** Runs in the commit that creates each of the run's conversations. */
  onConversation(write: (tx: Tx, conversationId: number) => void | Promise<void>): void;
  /** Runs once the run's Harness is open, before anything in it resumes. */
  beforeResume(settle: (harness: Harness) => void | Promise<void>): void;
  /** Runs when the run's process lets the run go (its work done, or a SIGTERM), while the Harness is still open. */
  beforeRelease(stop: (harness: Harness) => void | Promise<void>): void;
  /** The run is on the runner: its browser hand-over's answers are entries of its journal (a browser_hand_back row the
   *  runner applies, the live view's hand-back, the ask's expiry), read and written there, never as answer files
   *  (browser-person.ts personHands `answered`). */
  handoverInJournal?: boolean;
  /** The run is on the runner: its live viewers are handed over through the store, not through files in its directory
   *  (browser-live.ts putLiveViewer/dropLiveViewer). The browser tool's live-viewer writers hang off this: `put` hands a
   *  session's viewer over (its token sealed under the run's `sealKey`), `drop` takes one (or all of the run's) back. The
   *  three fields below are what builds these (the one store, the claim the row is written under, the seal key); a tool's
   *  binding reads `liveViewers`, never them directly. Absent on the server path, where the viewer lives in the run's
   *  directory (browser-live.ts sessionHandovers: writeHandover/dropHandover). */
  liveViewers?: { put(handover: LiveHandover): Promise<boolean>; drop(tag?: string): Promise<void> };
  /** The one store, for the live-viewer seam above (and the sign-in verify the runner saves). */
  store?: LiveViewerStore;
  /** The claim this run is held under: the live-viewer rows are written under it (its epoch fences them). */
  claim?: Claim;
  /** The key the live-viewer tokens are sealed under before they go to the store (store/seal.ts). */
  sealKey?: Buffer;
};

/** What a name stands for in the run: the pi tools it offers, and the extensions a conversation selects for them. */
export type ToolBinding = { tools: readonly ToolRegistration[]; extensions: readonly Extension[] };

/** `tool` alone in an extension named `name`, installed in the run's registry. */
function installTool(host: Pick<ToolHost, "install">, name: string, tool: ToolRegistration): ToolBinding {
  const extension = defineExtension({ name, tools: [tool] });
  host.install(extension);
  return { tools: [tool], extensions: [extension] };
}

/** What a call node's effect gets from the run's process: its signal, environment and work directory, one completion
 *  on the run's models (the `llm` tool's), and the ledger its paid requests are booked in (paid-calls.ts). */
export type EffectRun = { signal: AbortSignal; env: NodeJS.ProcessEnv; work: string; complete?: Complete; ledger?: Ledger };

export type ToolEntry = {
  /** One line, for capabilities. */
  summary: string;
  /** The environment variables it needs, by name. */
  needs: readonly string[];
  /** Whether a workflow's model node may name it. */
  nodes: boolean;
  /** What the name stands for, bound in the run's process once. */
  bind(host: ToolHost): Promise<ToolBinding>;
  /** What a workflow's `call` node `via: "tool"` naming it runs: its interpolated `args` in, the value its `out` schema
   *  checks out. Absent, no call node may name it. */
  effect?(args: Record<string, unknown>, run: EffectRun): Promise<unknown>;
  /** Only a workflow's call node runs it: no agent and no model node may name it. */
  callOnly?: true;
  /** Only an agent whose place is a sandbox may name it: it runs in the box (runnable.ts). */
  sandboxOnly?: true;
  /** No agent whose place is a sandbox may name it: it writes the run's work/ from this machine by paths a box's command
   *  could turn through a link (runnable.ts). */
  runnerOnly?: true;
};

const callOnly = (summary: string, effect: NonNullable<ToolEntry["effect"]>): ToolEntry => ({
  summary, needs: [], nodes: false, callOnly: true, effect,
  bind: async () => { throw new Error("a call-only tool binds no agent tool"); },
});

/** web_fetch, bound under `name`. */
const webFetchEntry = (name: string): ToolEntry => ({
  summary: `Read one public web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked (falling back to the direct fetch, saying why, when Parallel answers no page), a part at a time (offset, max_chars; the page fetched once a run): { ok, url, status, title, text, chars, truncated?, original_chars?, beyond_read?, offset?, next_offset?, html_chars?, converted?, links, links_omitted?, via, parallel?, refused?, error? }; html_chars, the page's whole length, when its HTML was cut at ${HTML_READ_CHARS.toLocaleString("en-US")} characters before it was read, so its text is only the start of the page; converted: "text" when the text is plain text, its conversion to markdown having run out of time; a private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused, never sent to Parallel.`,
  needs: [],
  nodes: true,
  bind: async (host) => {
    const tool = booking(webFetchTool(host.env, name)) as unknown as ToolRegistration;
    const extension = defineExtension({ name: name.replaceAll("_", "-"), tools: [tool] });
    host.install(extension);
    return { tools: [tool], extensions: [extension] };
  },
  // A call node's Page is the workflow's, not a model's context: it reads the most of a part by default, from the page
  // the run read (runPages) where it holds the URL. Its request to Parallel, when it makes one, is booked under the call
  // (paid-calls.ts); a part from what the run read makes none and books nothing.
  effect: async (args, run) => bookedIn(run.ledger, async () => fetchFor(run.env, args.url, { ...(await fetchOptions(run.env, FAUX_ENV)), offset: args.offset as number | undefined, maxChars: (args.max_chars as number | undefined) ?? TEXT_CAP, pages: runPages, signal: run.signal })),
});

/** A coding tool, from the run's coding source: a name it does not hold (bash on the runner) binds no tool. */
const fileTool = (name: string, summary: string, sandboxOnly = false): ToolEntry => ({
  summary,
  needs: [],
  nodes: !sandboxOnly,
  ...(sandboxOnly ? { sandboxOnly: true as const } : {}),
  bind: async (host) => {
    const tools = host.coding.tools.filter((tool) => tool.name === name);
    return { tools, extensions: tools.length ? [host.coding.extension] : [] };
  },
});

/** The folder the browser files what it reads in. */
const EVIDENCE = "evidence";
/** How many names taken by a link a read steps past before it gives up. */
const EVIDENCE_TRIES = 100;

/** The highest number a file in the run's evidence/ is named by (`0007-browser_read.md`), 0 for none or no folder. A
 *  link at evidence/ itself throws (ESCAPE): nothing is filed through it. */
async function lastEvidence(work: Workspace): Promise<number> {
  try {
    return Math.max(0, ...(await work.list(EVIDENCE)).map((entry) => Number(/^(\d+)-/.exec(entry.name)?.[1] ?? 0)));
  } catch (error) {
    if (isWorkspaceError(error, "NOT_FOUND")) return 0;
    throw error;
  }
}

/** Where the browser files what it reads: the run's `evidence/`, through its Workspace, so the run's files show it and
 *  the agent can read it back. A text body follows one line of the read's facts; a capture's bytes go beside its facts.
 *  Each read takes the next number after the highest the folder holds when the sink first files, so a later process's
 *  sink never overwrites one, and reads at once (parallel nodes, one turn's calls) each take their own. A name a link
 *  holds is never written through: the read takes the next. */
export const evidenceIn = (work: Workspace) => {
  let seq: Promise<{ n: number }> | undefined;
  return {
    file: async (label: string, record: { tool: string; facts: Record<string, unknown>; body: string | Uint8Array; ext?: string }) => {
      const facts = JSON.stringify({ label, tool: record.tool, ...record.facts });
      const text = typeof record.body === "string";
      const counter = await (seq ??= lastEvidence(work).then((n) => ({ n })));
      for (let tries = 0; ; tries++) {
        const name = `${String(++counter.n).padStart(4, "0")}-${record.tool}`;
        try {
          await work.write(`${EVIDENCE}/${text ? `${name}.md` : `${name}.json`}`, text ? `${facts}\n\n${record.body}` : `${facts}\n`);
        } catch (error) {
          if (isWorkspaceError(error, "ESCAPE") && tries < EVIDENCE_TRIES) continue;
          throw error;
        }
        if (text) return { path: `${EVIDENCE}/${name}.md`, bodyLine: 3 };
        await work.write(`${EVIDENCE}/${name}.${record.ext ?? "bin"}`, record.body);
        return { path: `${EVIDENCE}/${name}.json`, bodyPath: `${EVIDENCE}/${name}.${record.ext ?? "bin"}` };
      }
    },
  };
};

/** The Browserbase contexts a run's browser may open: its agent's saved sign-in's alone, by its profile name, never one
 *  made here (nothing a run makes is kept for its agent). */
export const keptContexts = (ref: string | undefined) => ({
  clear: false,
  resolve: async (key: string) => {
    if (ref && key.endsWith(`|profile:${SIGN_IN_KEY}`)) return ref;
    throw new Error("this run's browser has no saved sign-in to open");
  },
});

/** Kernel's provider, opening the agent's saved profile (`ref`, its name at Kernel) where a session asks for the
 *  profile `default`: the policy, the session's record and the model see only that name. */
export const keptProfile = <P extends { create(spec: { profile?: { name: string; save: boolean } }, signal: AbortSignal): unknown }>(provider: P, ref: string): P => ({
  ...provider,
  create: (spec, signal) => provider.create(spec.profile?.name === SIGN_IN_KEY ? { ...spec, profile: { ...spec.profile, name: ref } } : spec, signal),
});

/** `provider`, its sessions' profile as this launch was handed it, whatever the policy a conversation was made with (a
 *  follow-up's was made under an earlier launch, which may have had no sign-in, or another lease): with a sign-in, every
 *  session opens on the profile `default`, saving only as `kept.save` says; without one, none asks for a profile. */
export const asHanded = <P extends { create(spec: { profile?: { name: string; save: boolean } }, signal: AbortSignal): unknown }>(provider: P, kept: { save: boolean } | undefined): P => ({
  ...provider,
  create: (spec, signal) => provider.create(kept ? { ...spec, profile: { name: SIGN_IN_KEY, save: kept.save } } : spec.profile ? { ...spec, profile: undefined } : spec, signal),
});

/** Whether a session's change is one that saved to the run's sign-in, in a run that saves (every session of it runs on
 *  the profile, asHanded, whatever its record names): let go by the run (its tool, its idle time, a relaunch, its close,
 *  its end), never one the vendor had already lost or never made. */
export const savedOnRelease = (row: { session: { resourceId: string | null; releaseReason: string | null } }, change: string): boolean =>
  change === "released" && row.session.resourceId !== null && row.session.releaseReason !== null && !["lost", "create_failed"].includes(row.session.releaseReason);

/** A hosted browser driven through Stagehand, on pi-browser's durable adapter: Browserbase or Kernel (headless), the one
 *  the run's plane names (tool-plane.ts: picked, else Browserbase where the server holds its keys, else Kernel), kept
 *  for the run's life; a plane that names none (a run kept from before the pick) is Browserbase. Its sessions' custody
 *  lives in the run's own store. No recording; the owner watches it live, takes it over and hands it back, and the agent
 *  may ask them to (browser-live.ts, browser-person.ts). A session the run still holds is released when the run is let
 *  go. Where the plane says unavailable (its vendor's key gone since), each call is refused, saying why.
 *  Its session time is the run's spend, held under its cap before it runs (browser-cost.ts). A run handed its agent's
 *  saved sign-in for that vendor (sign-ins.ts, over its pipe) opens every session on it, as the profile `default`,
 *  saving only where it holds the agent's save lease; one that saved says so in its run directory. */
const browserTool: ToolEntry = {
  summary: "Drive a hosted browser, Browserbase's or Kernel's (picked in tool settings, else whichever's key the server holds): open pages, read and screenshot them, and act on them.",
  // Which vendor's keys it needs is the plane's to say (tool-plane.ts BROWSER_KEYS): neither alone is required.
  needs: [],
  nodes: true,
  // Its downloads and uploads go through work/ by path (pi-browser), which a box's command could turn through a link.
  runnerOnly: true,
  bind: async (host) => {
    const [{ BACKGROUND_CONTEXT: context }, { createBrowserExtension }, { DEFAULT_BROWSER_POLICY, BrowserFailureError, browserFailure, workspaceFiles }, { createDrivingGates, createLiveView, liveViewProvider }, live, person] = await Promise.all([
      import("@earendil-works/chord/context"),
      import("@parcha/pi-browser/durable"),
      import("@parcha/pi-browser"),
      import("@parcha/pi-browser/live-view"),
      import("./browser-live.js"),
      import("./browser-person.js"),
    ]);
    const vendor = planeOf(host.env).browser ?? "browserbase";
    const refused = isUnavailable(vendor) ? new BrowserFailureError(browserFailure("browser_unavailable", `The browser does not run here: ${whyUnavailable(vendor)}.`)) : undefined;
    const handed = handedSignIn();
    const kept = !refused && handed?.provider === vendor ? handed : undefined;
    const faux = host.env[FAUX_ENV] ? host.env[FAUX_BROWSER_ENV] : undefined;
    const parts = faux
      ? ((await import(pathToFileURL(faux).href)) as { default: (env: NodeJS.ProcessEnv, vendor: string, signIn?: typeof kept) => { provider: unknown; driver: unknown } }).default(host.env, vendor, kept)
      : {
          provider: refused
            ? undefined
            : vendor === "kernel"
              ? ((kernel) => (kept ? keptProfile(kernel, kept.ref) : kernel))((await import("@parcha/pi-browser/providers/kernel")).kernelProvider({ env: host.env, headless: true }))
              : (await import("@parcha/pi-browser/providers/browserbase")).browserbaseProvider({ env: host.env, profiles: keptContexts(kept?.ref) }),
          driver: (await import("@parcha/pi-browser/driver/stagehand")).stagehandDriver(),
        };
    // The save flag every session carries is this launch's (asHanded), never the one stored with its conversation.
    const handedProvider = parts.provider ? asHanded(parts.provider as Parameters<typeof asHanded>[0], kept) : undefined;
    // The owner's live view (browser-live.ts): pi-browser's own viewer on a loopback port of this process's, over every
    // provider (the handed one, the run's own), on the same person/model registry as the toolset; framed by the console's
    // own origin alone. The owner drives only after Take over, and the agent may ask them to (browser-person.ts): the
    // person's time is held under the run's cap first, and their turns are rows of the run's timeline.
    const windows = person.personWindows(host.env, Boolean(host.env[FAUX_ENV]));
    const gates = createDrivingGates({ holdIdleMs: windows.holdMs, holdAwayMs: windows.awayMs });
    let opened: Harness | undefined;
    const hands = person.personHands({
      root: host.where.root,
      gates,
      personTime: (what, seconds, options) => spend.personTime(what, seconds, options),
      carry: (tag, seconds) => spend.carry(tag, seconds),
      // The model's words for the person, with every value this run holds cut, whole, before they are cut to their bound.
      redact: (text) => redactedAnswer(text, [...hostSecrets(host.env), ...(kept ? [kept.ref] : [])]),
      note: async (kind, data) => void (await opened?.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data })), context)),
      holdMs: windows.holdMs,
      // The run's waiting rows for a session: each is an agent.handover entry of the root's, waiting, naming it.
      waiting: async (tag) => (await opened?.commit(async (tx) => {
        let count = 0;
        for (let cursor: Parameters<Tx["scanEntries"]>[2] | undefined; ; ) {
          const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 200, cursor);
          for (const entry of page.items) {
            const data = entry.data as { state?: unknown; session?: unknown } | undefined;
            if (entry.kind === "agent.handover" && data?.state === "waiting" && data.session === tag) count += 1;
          }
          if (page.next === undefined) return count;
          cursor = page.next;
        }
      }, context)) ?? 0,
      // On the runner: an ask's answer is the root's first answered hand-over entry for it (runner/hand-back.ts).
      ...(host.handoverInJournal ? {
        answered: async (id: string) => (await opened?.commit(async (tx) => {
          for (let cursor: Parameters<Tx["scanEntries"]>[2] | undefined; ; ) {
            const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 200, cursor);
            const found = answerIn(page.items, id);
            if (found) return { outcome: found.state, at: found.at, ...(found.reason !== undefined ? { reason: found.reason } : {}) };
            if (page.next === undefined) return undefined;
            cursor = page.next;
          }
        }, context)) ?? undefined,
      } : {}),
      // Tests only (--faux): the process dies once between an ask's record and its row.
      afterRecord: host.env[FAUX_ENV] && host.env[person.FAUX_ASK_DIES_ENV] ? () => {
        const mark = host.env[person.FAUX_ASK_DIES_ENV]!;
        if (existsSync(mark)) return;
        writeFileSync(mark, "");
        process.kill(process.pid, "SIGKILL");
      } : undefined,
    });
    const view = createLiveView({ hostOrigin: "'self'", gates, takeOver: { take: (tag) => hands.take(tag) } });
    const watched = handedProvider ? liveViewProvider(handedProvider as never, view) : undefined;
    const provider = () => {
      if (refused) throw refused;
      return watched as never;
    };
    // Each session's viewer reaches the server as it launches, and goes as it ends: on the runner through the store, under
    // the run's claim (host.liveViewers); on the old per-run process, in the run's directory, never work/.
    const viewers = live.sessionHandovers(host.where.root, host.liveViewers);
    const onSession = (row: { session: { tag: string }; liveView: { fullscreen: string } | null }, change: string) => viewers.changed(row, change);
    // Its session time is the run's spend, at its provider's price, and held under the run's cap (browser-cost.ts).
    const providerName = (parts.provider as { name?: string } | undefined)?.name ?? vendor;
    const price = browserPrice(providerName, host.env);
    const spend = browserSpend(providerName, price, DEFAULT_BROWSER_POLICY.idleReleaseS, (conversation, at) => browser.release(conversation as never, "close", at));
    // browser_downloads is listed only with a workspace to copy into, and only a provider that keeps a session's downloads
    // (Browserbase's; Kernel's keeps none) has any: without one, uploads still read the run's work/, through `files`.
    const downloads = typeof (parts.provider as { downloads?: unknown } | undefined)?.downloads === "object";
    const files = downloads ? { workspace: () => host.where.work } : { files: workspaceFiles(host.where.work) };
    // A session that saved to the sign-in, let go: its time, for the sign-in's verified_at when the run's lease ends.
    const saved = kept?.save
      ? (row: Parameters<typeof savedOnRelease>[0], change: string) => void (savedOnRelease(row, change) && writeFileSync(join(host.where.root, SIGN_IN_SAVED), new Date().toISOString(), { mode: 0o600 }))
      : undefined;
    // Both hosts of a session's changes: the live view's hand-over, and the sign-in's saved mark.
    const onSessions = async (row: Parameters<typeof savedOnRelease>[0] & Parameters<typeof onSession>[0], change: string) => {
      saved?.(row, change);
      await onSession(row, change);
    };
    // The pointer is cut from everything the browser hands the model (its results, their details, its failures): a
    // vendor's refusal can quote it, as pi-browser's one-saver rule names Kernel's profile.
    // A run handed its agent's sign-in tells the model its browser keeps it (`run`'s description): one with none claims
    // cookies across pages only.
    const browser = createBrowserExtension({ provider, driver: parts.driver as never, evidence: evidenceIn(localWorkspace(host.where.work)) as never, ...files, gates, handoff: hands.handoff, onSession: onSessions as never, signIns: kept !== undefined, beforeCreate: spend.opening, redact: { values: () => (kept ? [kept.ref] : []) }, prices: { sessionUsdPerHour: price.usdPerHour, sessionMinimumS: price.minimumS }, onCharge: spend.onCharge });
    const tools = (browser.tools as unknown as ToolRegistration[]).map(spend.capped);
    const extension = { ...(browser.extension as unknown as Extension), tools } as Extension;
    host.install(extension);
    host.onConversation(async (tx, conversationId) => {
      // The profile is the host's choice, never the model's: the agent's one sign-in, when the run was handed it.
      const policy = kept ? { ...DEFAULT_BROWSER_POLICY, profile: { name: SIGN_IN_KEY, save: kept.save } } : DEFAULT_BROWSER_POLICY;
      Object.assign(await tx.doc(browser.docs.Config, conversationId as never), { label: "run", run: host.where.ref.id, policy });
    });
    host.beforeResume(async (harness) => {
      opened = harness;
      // Its charges move what the process counts once each is committed, reconcile's own among them.
      spend.watch(harness, (browser.docs.Inventory as unknown as { definition: { kind: string } }).definition.kind);
      // With its vendor's key gone there is no session to reconcile or release from here: each would only fail.
      if (refused) return;
      // Every session custody still tracks across a restart is held from here; one kept is released an idle window on
      // unless a call uses it.
      await browser.reconcile(harness as never, () => true, context);
      await spend.reopened(harness, browser.docs, context);
      // A session kept across the restart has no viewer in this process yet, and reconcile tells no session's change: each
      // one's viewer is opened here and handed over, as a launch's is. It starts with nobody holding the browser.
      const kept = Object.values(((await harness.snapshot(browser.docs.Inventory as never, context)) as { rows?: Record<string, { tag: string; resourceId: string | null; state: string }> } | undefined)?.rows ?? {});
      for (const row of kept.filter((r) => (r.state === "live" || r.state === "held") && r.resourceId !== null)) {
        try {
          const opened = await watched?.liveView?.({ id: row.resourceId!, tag: row.tag });
          await viewers.reopened(row.tag, opened?.fullscreen);
        } catch {
          // A browser that cannot be reached has no view to give: the owner reads none, as for any session without one.
        }
      }
    });
    host.beforeRelease(async (harness) => {
      try {
        if (refused) return;
        const held = await harness.snapshot(browser.docs.Inventory as never, context) as { rows?: Record<string, { conversationId: number; state: string }> } | undefined;
        for (const id of new Set(Object.values(held?.rows ?? {}).filter((row) => row.state !== "released").map((row) => row.conversationId))) {
          const conversation = await harness.conversation(id as never, context);
          if (conversation) await browser.release(conversation as never, "close", context);
        }
        await browser.drain(harness as never, context);
      } finally {
        // Every viewer's token dies with the process's hold on its sessions, and the hand-over with it; the person's
        // holds go, and the asks with them.
        await view.close();
        hands.close();
        await viewers.released();
        person.dropAsks(host.where.root);
      }
    });
    return { tools, extensions: [extension] };
  },
};

export const TOOLS: Readonly<Record<string, ToolEntry>> = Object.freeze({
  read: fileTool("read", "Read a file in the run's work/; in a sandbox, an image anywhere in the run's box too (a render in /tmp)."),
  write: fileTool("write", "Write a file in the run's work/."),
  edit: fileTool("edit", "Edit a file in the run's work/."),
  bash: fileTool("bash", "Run a bash command in the run's box, from its work/, never on this server itself: only an agent whose place is a sandbox names it. Its output's tail; 120 s unless the call names a timeout, at most 600 s (longer work: bash_background).", true),
  // The background tools (background.ts): each call a short command in the run's box, on bash's environment.
  bash_background: fileTool("bash_background", `Start a command in the background in the run's box, from its work/, and get its id at once: its stdout and stderr go to work/background/<id>/output.log (the first ${BACKGROUND_LOG_BYTES / (1024 * 1024)} MiB), its stdin is a pipe (a terminal with tty: true), and the run's end ends it; at most ${BACKGROUND_MAX} run at once. Only an agent whose place is a sandbox names it.`, true),
  bash_output: fileTool("bash_output", `Read a background process's output from a byte offset, at most ${BACKGROUND_PAGE_BYTES / 1024} KiB a call, with whether it still runs, its exit code and the next offset. Sandbox only.`, true),
  bash_input: fileTool("bash_input", "Write text to a running background process's stdin, and close it if asked. Sandbox only.", true),
  bash_signal: fileTool("bash_signal", "Send TERM, INT or KILL to a background process's process group. Sandbox only.", true),
  bash_list: fileTool("bash_list", "List the run's background processes: id, state or exit code, output size and command. Sandbox only.", true),
  [ASK_TOOL]: {
    summary: "Ask the person who started the run; the turn ends until a message answers.",
    needs: [],
    nodes: false,
    bind: async (host) => installTool(host, "person", askPerson as ToolRegistration),
  },
  [WEB_FETCH_TOOL]: webFetchEntry(WEB_FETCH_TOOL),
  [WEB_SEARCH_TOOL]: {
    summary: "Search the web: codex's own search (claude-agent's where it is picked), on pi the model provider's hosted search (Anthropic, OpenAI), with none of those Parallel's Search API where the server holds its key, else Exa's keyless search; or the provider picked: { query, n? } -> { provider, query, results: [{ url, title, snippet, published? }], text? }, provider naming the one that served it, 1 to 25 results, each snippet at most 3,000 characters; { error } when the search gives no answer.",
    needs: [],
    nodes: true,
    bind: async (host) => installTool(host, "web-search", booking(webSearchTool(host.env)) as unknown as ToolRegistration),
    effect: async (args, run) => bookedIn(run.ledger, () => searchFor(run.env, args, run.signal)),
  },
  browser: browserTool,
  // monid's catalog on one key (monid.ts): every harness calls each by its wire name, `monid_discover` and the rest.
  "monid.discover": monidTool("discover"),
  "monid.inspect": monidTool("inspect"),
  "monid.run": monidTool("run"),
  [PDF_PAGES_TOOL]: callOnly(
    "A workflow call: { path, maxPages?, dpi? } -> { name, pageCount, dpi, pages: [{ page, image }], text }; the document's first pages drawn as PNGs under work/pages/<stem>/<dpi>/ (the dpi lowered so a page's long side is at most 1568 px), from the server's documents (--documents) or the run's work directory.",
    (args, run) => pdfPages(args, { work: localWorkspace(run.work), documents: run.env[DOCUMENTS_ENV], signal: run.signal }),
  ),
  [LLM_TOOL]: callOnly(
    "A workflow call: { prompt, system?, maxTokens?, tier? } -> { text, model, usage, cost_usd }; one completion on the model of the tier (default), no tools and no loop.",
    (args, run) => {
      if (!run.complete) throw new Error("llm: this run has no model to complete on");
      return run.complete(args, run.signal);
    },
  ),
});

/** Every name a revision may name, those a workflow's model node may, and those a workflow's call node may run. */
export const BOUND_TOOLS: readonly string[] = Object.keys(TOOLS).filter((name) => !TOOLS[name]!.callOnly);
export const NODE_TOOLS: readonly string[] = BOUND_TOOLS.filter((name) => TOOLS[name]!.nodes);
export const CALL_TOOLS: readonly string[] = Object.keys(TOOLS).filter((name) => TOOLS[name]!.effect !== undefined);
/** Whether `name` is one of `allowed`. */
export const allows = (allowed: readonly string[], name: string): boolean => allowed.includes(name);

/** The tools a run's learned workflow may name (learn/check.ts at learn time, learned-workflow.ts at a call): those of the
 *  agent's `granted` tools a workflow's call node runs here (CALL_TOOLS), and with the run's `plane`, none it resolves unavailable (its agent's own tool of the name does not run either). A
 *  learned model node runs without tools (learn/skills.ts MODEL_NODE_TOOLS), and a harness's own tool (Bash,
 *  exec_command, apply_patch) is never one, so the DSL refuses a draft that names it. */
export const learnedWorkflowTools = (granted: readonly string[], plane?: Plane): string[] =>
  [...new Set(granted.filter((name) => allows(CALL_TOOLS, name) && !isUnavailable(plane?.[name as Pickable])))];

/** The tools a learned draft may name (learnedWorkflowTools) that the gate allows: `permission` is what the gate holds a
 *  tool to now (tool-gate.ts permissionOf, or the run's gate's policy), by its settings key. One set to ask or deny is left out of `tools`, so the end-of-run prompt never offers it, and named
 *  in `gated` with its setting, which the checker and a learned workflow's check before it runs refuse a draft for. */
export const learnedDraftTools = (granted: readonly string[], permission: (name: string) => string, plane?: Plane, from?: (name: string) => SettingFrom): { tools: string[]; gated: Record<string, string>; deniedBy: Record<string, DenyFrom> } => {
  const gated: Record<string, string> = {};
  // Where each deny was set (this agent's settings or this server's), so the refusal names it.
  const deniedBy: Record<string, DenyFrom> = {};
  const tools = learnedWorkflowTools(granted, plane).filter((name) => {
    const setting = permission(name);
    if (setting === "allow") return true;
    gated[name] = setting;
    // A deny comes from a layer or the default, never from approvals, which only ever allows.
    if (setting === "deny" && from) deniedBy[name] = from(name) as DenyFrom;
    return false;
  });
  return { tools, gated, deniedBy };
};

/** The tools a workflow names (`nodes` from workflowNodes): on its model nodes (`tools`), and on its `call` nodes
 *  `via: "tool"` (`tool`). */
export function workflowTools(nodes: readonly Record<string, unknown>[]): { nodes: string[]; calls: string[] } {
  const named = new Set<string>();
  const calls = new Set<string>();
  for (const node of nodes) {
    if (node.node === "call" && node.via === "tool" && typeof node.tool === "string") calls.add(node.tool);
    else if (Array.isArray(node.tools)) for (const name of node.tools) if (typeof name === "string") named.add(name);
  }
  return { nodes: [...named], calls: [...calls] };
}

/** The tools a revision grants its run: an agentic revision's `tools`; a workflow revision's `tools` with those its model
 *  and call nodes name, which its run binds whether `tools` lists them or not. */
export async function grantedTools(revision: { kind: string; tools?: readonly string[]; workflow?: unknown }): Promise<string[]> {
  if (revision.kind !== "workflow") return [...(revision.tools ?? [])];
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const named = workflowTools(workflowNodes(revision.workflow, inspectWorkflow(revision.workflow)));
  return [...new Set([...(revision.tools ?? []), ...named.nodes, ...named.calls])];
}

/** The table's entry for `name`, or undefined for a name it does not hold. */
export const toolOf = (name: string): ToolEntry | undefined => (Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined);

/** What a stored revision's tools resolve from (tool-plane.ts): the tools it grants, its harness, model and settings. */
export async function toolingOf(revision: Revision): Promise<Tooling> {
  const tools = await grantedTools(revision.kind === "agentic" ? { kind: "agentic", tools: revision.body.tools } : { kind: "workflow", tools: revision.body.tools, workflow: revision.body.workflow });
  return { tools, ...(revision.kind === "workflow" ? { workflow: true as const } : {}), ...(revision.body.harness ? { harness: revision.body.harness } : {}), ...(revision.kind === "agentic" && revision.body.model ? { model: revision.body.model } : {}), ...(revision.body.toolSettings ? { overrides: revision.body.toolSettings as ToolSettingsMap } : {}), ...(revision.body.approvals === "never" ? { approvals: "never" as const } : {}) };
}

/** The variables `entry` needs that `env` does not set, by name. */
export const missingEnv = (entry: ToolEntry, env: NodeJS.ProcessEnv): string[] => entry.needs.filter((name) => !env[name]);

/** What keeps `names` from being bound here: names outside the table (or, for a workflow's model nodes, that a node may
 *  not name), and the variables each tool in it needs that `env` does not set. Undefined when nothing does. */
export function toolRefusal(names: readonly string[], env: NodeJS.ProcessEnv, where: "agent" | "nodes" | "calls" = "agent"): { message: string; unbound: string[]; missing: Record<string, string[]> } | undefined {
  const allowed = where === "nodes" ? NODE_TOOLS : where === "calls" ? CALL_TOOLS : BOUND_TOOLS;
  const unbound = names.filter((name) => !allows(allowed, name));
  if (unbound.length) {
    const said = { agent: "agentrun-serve binds the tools", nodes: "A workflow's model nodes get the tools", calls: "A workflow's call nodes run the tools" }[where];
    return { message: `${said} ${allowed.join(", ")}; this ${where === "agent" ? "revision" : "workflow"} also ${where === "calls" ? "calls" : "names"} ${unbound.join(", ")}.`, unbound, missing: {} };
  }
  const missing = Object.fromEntries(names.map((name) => [name, missingEnv(toolOf(name)!, env)] as const).filter(([, vars]) => vars.length));
  const lacking = Object.entries(missing);
  if (!lacking.length) return undefined;
  const said = lacking.map(([name, vars]) => `The tool ${name} needs ${keyNeeded(vars)}.`).join(" ");
  return { message: `This server holds no key for what the revision's tools need. ${said}`, unbound: [], missing };
}

/** Every tool as capabilities show it, the server's one tool catalog: available here, or the variables it is missing
 *  (names only), and the harnesses that run it (another harness than pi runs only the host tools, host-tools.ts). A tool
 *  a user picks a provider for (tool-plane.ts) gives the providers offered, the server's (`provider`, the default where it
 *  sets none), the default, and what it resolves to on each harness under the server's `settings`: available where any
 *  is not unavailable, and missing PARALLEL_API_KEY where Parallel is picked without it. An unavailable tool says why
 *  (`reason`). `noBox`: why no box can run a sandbox-only tool here (place.ts noBoxReason), which leaves it
 *  unavailable with that reason; undefined, a box can. `refused`: the variables of the keys this server was started with
 *  that their provider refused at the start (ToolKeys.refused), each with why: a tool that needs one is unavailable,
 *  saying that. Each tool also gives its permission under the server's settings (tool-gate.ts), the owner's default
 *  and the permissions it may be set to. */
export const toolsView = (env: NodeJS.ProcessEnv, settings: ToolSettingsMap = {}, noBox?: string, refused: Readonly<Record<string, string>> = {}) => {
  const views = explainsView(env, settings);
  const picked = withDefaults(settings);
  return Object.entries(TOOLS).map(([name, entry]) => {
    const view = (PICKABLE as readonly string[]).includes(name) ? views[name as Pickable] : undefined;
    const plane = view?.resolves;
    const missing = plane && Object.values(plane).includes(NO_PARALLEL_KEY) ? [PARALLEL_KEY_ENV] : missingEnv(entry, env);
    const boxless = entry.sandboxOnly ? noBox : undefined;
    // The browser needs the keys of the vendor it resolves to: one refused at the start leaves it unavailable, never on the
    // other vendor, as a refused Parallel key never moves web_search elsewhere.
    const needs = name === "browser" ? [...new Set(Object.values(plane ?? {}).flatMap(browserNeeds))] : entry.needs;
    const refusal = needs.map((name) => (Object.hasOwn(refused, name) ? refused[name] : undefined)).find((why) => why !== undefined);
    const available = (plane ? Object.values(plane).some((resolution) => !isUnavailable(resolution)) : missing.length === 0) && boxless === undefined && refusal === undefined;
    // Unavailable says why: a sandbox-only tool no box here can run, why none can (`noBox`); on a tool a user picks a
    // provider for, the resolutions' own words (`web_search is turned off in settings`); else the variables it needs.
    const reason = available ? undefined : refusal ?? boxless ?? (plane ? [...new Set(Object.values(plane).filter(isUnavailable).map(whyUnavailable))].join("; ") : `Needs ${keyNeeded(missing)}`);
    return { name, summary: entry.summary, ...(blurbOf(name) ? { blurb: blurbOf(name) } : {}), nodes: entry.nodes, calls: entry.effect !== undefined, ...(entry.callOnly ? { call_only: true } : {}), ...(entry.sandboxOnly ? { sandbox_only: true } : {}), available, ...(reason ? { reason } : {}), ...(missing.length ? { missing } : {}), harnesses: name in REPLAY ? [...HARNESSES] : [DEFAULT_HARNESS], ...serverGate(name, settings), ...(plane ? { providers: [...PROVIDERS[name as Pickable]], provider: picked[name as Pickable].provider, default_provider: PROVIDERS[name as Pickable][0], resolves: plane, why: view!.why } : {}) };
  });
};
