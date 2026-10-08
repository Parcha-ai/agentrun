// The model contract: each tool's name, description, argument schema, effect class and replay class, and the static
// `browser` section. Every word the model reads from this package lives in this file; adapters register it unchanged
// and a host adds its own words around it (a wrapped description, a section addendum), never inside it.
//
// Schemas are plain JSON Schema: pi validates a call's arguments against them before `execute`, and the coding agent
// takes the same objects. `snapshot`, `run` and `screenshot` keep the Stagehand facade's descriptions and schemas
// (models are prompted against them, and the driver's drift test compares them with the vendored upstream);
// `screenshot` adds `ask`, the question a capture is taken to answer.

export type JsonSchema = { readonly [key: string]: unknown };

/** What a call can do to the world. `read` changes nothing a rerun could double; `effect` may act on a site;
 *  `custody` opens or closes a paid session, at most once by its tag. */
export type EffectClass = "read" | "effect" | "custody";

export type ToolContract = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly effect: EffectClass;
  /** pi-durable's replay class: a `safe` call cut by a crash reruns with the same arguments; an `unsafe` one is
   *  reported interrupted and never rerun. */
  readonly replay: "safe" | "unsafe";
  /** One sequential call makes its whole round sequential: a session's calls run in order. */
  readonly executionMode: "sequential" | "parallel";
  /** What the call files: nothing, a page receipt, an image with a receipt, files with a manifest, or returned URLs. */
  readonly evidence: "none" | "receipt" | "image" | "files" | "urls";
  /** When a host lists the tool: always, or only when the provider and the host can serve it. */
  readonly listedWhen: "always" | "downloads" | "fetch" | "search";
};

const actionSchema = (op: string, extra: Record<string, Record<string, unknown>> = {}) => ({
  type: "object",
  properties: {
    op: { const: op, description: `Action operation. Use "op": "${op}"; never use a "kind" field.` },
    id: { type: "string", description: 'Bracketed ID copied from the latest snapshot, as a string. Use "id"; never use "ref".' },
    ...extra,
  },
  required: ["op", "id", ...Object.keys(extra).filter((key) => key !== "delay")],
  additionalProperties: false,
});

const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema =>
  ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });

const snapshot: ToolContract = {
  name: "snapshot",
  label: "Browser: snapshot",
  description: "Capture the active page's Stagehand accessibility tree and hydrate its displayed IDs for subsequent run actions. Every call replaces the active page's ID map.",
  parameters: object({ includeIframes: { type: "boolean", default: true } }),
  effect: "read", replay: "safe", executionMode: "sequential", evidence: "none", listedWhen: "always",
};

const run: ToolContract = {
  name: "run",
  label: "Browser: run",
  description: 'Browse and automate websites in the persistent Stagehand browser. Navigate with JavaScript such as await page.goto("https://example.com"); there is no separate navigate or start tool. Execute either a JavaScript workflow against the Stagehand Playwright facade or a batch of actions using IDs from the latest snapshot. Provide exactly one of code or actions. Each action must use "op" (never "kind") and "id" (never "ref"). Copy the bracketed snapshot ID as a string. Examples: {"actions":[{"op":"click","id":"1-42"}]}, {"actions":[{"op":"fill","id":"2-14","value":"Miami"}]}, {"actions":[{"op":"select","id":"3-9","values":"Lowest price"}]}.',
  // No top-level oneOf for "exactly one of code or actions": AI-SDK-based clients reject a top-level oneOf. The
  // description states it and the tool enforces it.
  parameters: object({
    code: { type: "string", minLength: 1 },
    actions: {
      type: "array",
      description: 'Snapshot actions with the exact fields "op" and "id". Do not use "kind" or "ref".',
      items: {
        oneOf: [
          actionSchema("click"),
          actionSchema("hover"),
          actionSchema("fill", { value: { type: "string" } }),
          actionSchema("type", { text: { type: "string" }, delay: { type: "number", minimum: 0 } }),
          actionSchema("press", { key: { type: "string" } }),
          actionSchema("select", { values: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }] } }),
        ],
      },
      minItems: 1,
    },
  }),
  effect: "effect", replay: "unsafe", executionMode: "sequential", evidence: "none", listedWhen: "always",
};

const screenshot: ToolContract = {
  name: "screenshot",
  label: "Browser: screenshot",
  description: 'Capture a screenshot of the active page. For size-constrained MCP clients, prefer a viewport JPEG: {"type":"jpeg","quality":40,"fullPage":false}.',
  parameters: object({
    fullPage: { type: "boolean" },
    type: { type: "string", enum: ["png", "jpeg"] },
    quality: { type: "number", minimum: 0, maximum: 100 },
    ask: { type: "string", description: "What you want to know from this capture. Answered from the pixels when your model cannot see them; echoed back when it can." },
  }),
  effect: "read", replay: "safe", executionMode: "sequential", evidence: "image", listedWhen: "always",
};

const browserRead: ToolContract = {
  name: "browser_read",
  label: "Browser: read",
  description:
    "Read the CURRENT page of the browser as evidence and persist it under evidence/ with the page URL: " +
    "`what` = markdown (the whole page as markdown, the default for citing), text, html, url, or title. " +
    "This is the citable door for anything you saw in the browser: snapshot, screenshot and run return values are not evidence. Cite the returned URL.",
  parameters: object({ what: { type: "string", enum: ["markdown", "text", "html", "url", "title"], description: "Default markdown." } }),
  effect: "read", replay: "safe", executionMode: "sequential", evidence: "receipt", listedWhen: "always",
};

const browserRelease: ToolContract = {
  name: "browser_release",
  label: "Browser: release",
  description:
    "Release the browser session now. Call it as soon as you are done browsing for this task: an open session costs browser minutes whether or not you use it. " +
    "Your next browser call launches a fresh session (a new tab, no cookies from the old one), so finish a flow before releasing.",
  parameters: object({}),
  effect: "custody", replay: "safe", executionMode: "sequential", evidence: "none", listedWhen: "always",
};

const browserRelaunch: ToolContract = {
  name: "browser_relaunch",
  label: "Browser: relaunch",
  description:
    "Replace the browser session with a fresh one. Use `verified: true` only after a site blocked the proxied session (403/429, a CAPTCHA wall, a bot-detection page, an empty page that should have content): a Verified browser carries a stronger identity and costs more. " +
    "Use `geolocation` to browse as a visitor from a given place: the proxy egresses from that country (ISO alpha-2), optionally a US state and a city, so geo-aware sites (storefront region, prices, payment methods, content availability) show what a local sees. " +
    "Page state is lost; navigate again with run.",
  parameters: object({
    verified: { type: "boolean", description: "Launch the new session as a Verified browser. Omitted, the new session is not Verified, even when the run launches Verified browsers by default." },
    geolocation: {
      type: "object",
      additionalProperties: false,
      description: "Proxy egress location for the new session. Omit to keep the run's default.",
      properties: {
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. GB, US, DE." },
        state: { type: "string", description: "US state abbreviation, United States only." },
        city: { type: "string", description: "City name, e.g. LONDON or SAO_PAULO." },
      },
      required: ["country"],
    },
  }),
  effect: "custody", replay: "safe", executionMode: "sequential", evidence: "none", listedWhen: "always",
};

const browserDownloads: ToolContract = {
  name: "browser_downloads",
  label: "Browser: downloads",
  description:
    "Copy the files this browser session downloaded into the workspace under downloads/, with downloads/manifest.json listing each file's SHA-256. " +
    "Returns the files fetched now, those fetched before and those skipped, never their bytes; open a fetched file with read.",
  parameters: object({}),
  effect: "read", replay: "safe", executionMode: "sequential", evidence: "files", listedWhen: "downloads",
};

const webFetch: ToolContract = {
  name: "web_fetch",
  label: "Web fetch",
  description:
    "Fetch one URL as clean markdown without a browser session: fast and cheap, and it handles most static and many dynamic pages. " +
    "Use it for reading articles, filings, registries, PDFs-as-pages. If it returns blocked or empty content, drive the page with run/snapshot instead. " +
    "The result is persisted as evidence with its URL.",
  parameters: object({
    url: { type: "string", description: "Absolute http(s) URL." },
    format: { type: "string", enum: ["markdown", "raw"], description: "Default markdown." },
  }, ["url"]),
  effect: "read", replay: "safe", executionMode: "parallel", evidence: "receipt", listedWhen: "fetch",
};

const webSearch: ToolContract = {
  name: "web_search",
  label: "Web search",
  description: "Search the web. Returns ranked results with url and title, and author and publication date where the source has them.",
  parameters: object({ query: { type: "string" }, n: { type: "number", description: "Results to return, 1-25 (default 10)." } }, ["query"]),
  effect: "read", replay: "safe", executionMode: "parallel", evidence: "urls", listedWhen: "search",
};

/** The `browser` extension's tools, in the order a host lists them. */
export const BROWSER_TOOLS: readonly ToolContract[] = Object.freeze([snapshot, run, screenshot, browserRead, browserRelease, browserRelaunch, browserDownloads]);
/** The `web` extension's tools: sessionless, parallel, replay safe. */
export const WEB_TOOLS: readonly ToolContract[] = Object.freeze([webFetch, webSearch]);

export const BROWSER_TOOL_NAMES = Object.freeze(BROWSER_TOOLS.map((tool) => tool.name));
export const WEB_TOOL_NAMES = Object.freeze(WEB_TOOLS.map((tool) => tool.name));

/** The static `browser` section. It depends only on the conversation's configuration, never on live state, so it
 *  renders the same text for every request of a conversation and keeps the provider's prompt cache. */
export function browserSection(policy: { readonly idleReleaseS: number }): string {
  const idle = Math.round(policy.idleReleaseS);
  return [
    "You control one remote browser:",
    "- snapshot: the active page's accessibility tree, with bracketed element IDs for run actions.",
    "- run: snapshot actions by ID, or JavaScript against the Playwright-shaped page API. Pass exactly one of code or actions; every action uses \"op\" and \"id\", never \"kind\" or \"ref\".",
    "- screenshot: the rendered page as an image.",
    "- browser_read: the current page's content, filed as evidence with its URL.",
    "- browser_relaunch: a fresh session, Verified or egressing from a given place.",
    "- browser_release: release the session when you are done browsing.",
    "",
    "Snapshot IDs are valid only for the latest snapshot of the active page; snapshot again after navigation or a stale ID. Use snapshot actions for single clicks and fills, and one run code call for a multi-step workflow that returns only the values you need. Do not launch another browser; open more tabs with context.newPage() inside run code.",
    "",
    // This list is pinned by test/stagehand_driver.test.mjs: when those throws flip upstream, this paragraph goes.
    "The `run` page is Playwright-shaped, not Playwright. On this browser these throw: `page.waitForEvent(\"download\")`, `page.route`, `page.waitForResponse`, `context.newCDPSession`, and `page.on` for `pageerror`, `framenavigated` or `response`. Wait for what the page shows instead (`page.waitForSelector`, `page.waitForLoadState`, or poll `page.url()` or a locator's text in a short loop), read results from the page itself (a locator's text, then `browser_read` to cite it), and never intercept or rewrite requests. A file the page offers as a download cannot be collected from the browser: take the link's URL from the page and fetch it with `web_fetch` when that tool is offered, or cite the page that links it.",
    "",
    // The navigation race: a page call issued while a submit's navigation commits throws -32000 or hangs; a bounded wait
    // plus one retry of the read held 80 of 80 runs.
    "After a click that loads a new page, wait for the next page with a bounded wait before reading it (for example `await page.waitForSelector(\"#result\", { timeout: 1000 })`), and if a read made while the page was changing throws \"Inspected target navigated or closed\" or \"Cannot find context with specified id\", run that read once more: it is a read, so repeating it is safe.",
    "",
    "Readers and actors: snapshot, screenshot and browser_read only read the page, and a read cut by an interruption runs again by itself. run acts on the site, so a run cut by an interruption is never repeated for you: you are told it was interrupted and on which page, and you check the page before acting again.",
    "",
    `The browser is remote. It is launched on your first browser call and released when you call browser_release, after ${idle} seconds without a browser call, or when your work ends; the call after a release opens a fresh session with no cookies or page state.`,
    "",
    "Evidence: browser_read and screenshot are citable, filed with the page URL. snapshot and run return values are working views, not evidence.",
    "",
    "Never repeat a failing call unchanged: the third identical call that failed the same way is refused. Change the code, the IDs (snapshot again), the URL or the approach.",
  ].join("\n");
}
