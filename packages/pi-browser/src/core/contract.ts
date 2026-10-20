export type JsonSchema = { readonly [key: string]: unknown };

/** `read` changes nothing a rerun could double; `effect` may act on a site; `custody` opens or closes a paid session. */
export type EffectClass = "read" | "effect" | "custody";

export type ToolContract = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly effect: EffectClass;
  /** After a crash a `safe` call reruns with the same arguments; an `unsafe` one is reported interrupted, never rerun. */
  readonly replay: "safe" | "unsafe";
  /** One sequential call makes its whole round sequential. */
  readonly executionMode: "sequential" | "parallel";
  readonly evidence: "none" | "receipt" | "image" | "files" | "urls";
  readonly listedWhen: "always" | "downloads" | "upload" | "fetch" | "search" | "sites" | "handoff";
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
  // No top-level oneOf for "exactly one of code or actions": AI-SDK-based clients reject it, so the tool enforces it.
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
    ask: { type: "string", description: "What you want to know from this capture. It travels with the image, so a host can answer it from the pixels when your model cannot see them." },
    clip: { ...object({ x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, ["x", "y", "width", "height"]), description: "Capture only this region, in CSS pixels from the viewport's top-left corner (what the page shows now). Width and height 0 mean no clip: leave it out, or send zeros, to capture the whole viewport. A region that leaves the viewport is refused. Use one of clip, id or selector; an empty id or selector means none." },
    id: { type: "string", description: "Capture only this element: a bracketed ID from the latest snapshot, as a string. It is scrolled into view first. It must match one element." },
    selector: { type: "string", description: "Capture only the element this CSS selector matches (when there is no snapshot ID for it). It is scrolled into view first. It must match exactly one element." },
  }),
  effect: "read", replay: "safe", executionMode: "sequential", evidence: "image", listedWhen: "always",
};

const browserRead: ToolContract = {
  name: "browser_read",
  label: "Browser: read",
  description:
    "Read the CURRENT page of the browser as evidence and persist it under evidence/ with the page URL: " +
    "`what` = markdown (the whole page as markdown, the default for citing), text, html, url, or title. " +
    "This is the citable door for anything you saw in the browser: snapshot, screenshot and run return values are not evidence. Cite the returned URL. " +
    "A browser page URL in a receipt keeps its query names but shows every value replaced by a redaction marker, the word redacted in square brackets (the site chose where the browser went, and a value in it can be a credential); web_fetch keeps a query value that is in the URL you asked for.",
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
    "Replace the browser session with a fresh one, after a site blocked it (403/429, a CAPTCHA wall, a bot-detection page, an empty page that should have content). The new session is Verified whenever the run's sessions are, and a relaunch never lowers that: `verified: true` asks for a Verified session where the run's sessions are not (a Verified browser carries a stronger identity and costs more). " +
    "Use `geolocation` to browse as a visitor from a given place: the proxy egresses from that country (ISO alpha-2), optionally a US state and a city, so geo-aware sites (storefront region, prices, payment methods, content availability) show what a local sees. " +
    "Page state is lost; navigate again with run.",
  parameters: object({
    verified: { type: "boolean", description: "true launches the new session as a Verified browser. false, or leaving it out, keeps the run's setting: a Verified run's sessions stay Verified." },
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

const browserRequestHandoff: ToolContract = {
  name: "browser_request_handoff",
  label: "Browser: hand to a person",
  description:
    "Hand the browser to a person for a step only a human can do: a CAPTCHA you cannot pass, a sign-in that needs their device, a confirmation only they can give. " +
    "Say in instruction what they should do and in completion_condition what the page shows once it is done. The call waits until the person finishes, cancels or the request expires; while they have the browser, every other browser call fails with waiting_for_human. " +
    "The same request_id retries the same request. Afterwards take a snapshot and check the completion condition on the page before acting.",
  parameters: object({
    request_id: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "A UUID you choose for this request; the same one retries the same request." },
    instruction: { type: "string", minLength: 1, maxLength: 2000, description: "What the person should do, in plain words." },
    completion_condition: { type: "string", minLength: 1, maxLength: 1000, description: "What the page shows once the step is done, for you to verify afterwards." },
  }, ["request_id", "instruction", "completion_condition"]),
  effect: "custody", replay: "safe", executionMode: "sequential", evidence: "none", listedWhen: "handoff",
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

const browserUpload: ToolContract = {
  name: "browser_upload",
  label: "Browser: upload",
  description:
    "Choose one workspace file in a file input on the page, as a person picking it would; nothing is submitted. " +
    "Returns the file's name, size and SHA-256; submit the form with run afterwards.",
  parameters: object({
    path: { type: "string", minLength: 1, maxLength: 1000, description: "The file's path relative to the workspace, for example reports/q3.pdf." },
    selector: { type: "string", minLength: 1, maxLength: 500, description: "CSS selector of the <input type=\"file\">, for example input[type=file]." },
  }, ["path", "selector"]),
  effect: "effect", replay: "unsafe", executionMode: "sequential", evidence: "none", listedWhen: "upload",
};

const webFetch: ToolContract = {
  name: "web_fetch",
  label: "Web fetch",
  description:
    "Fetch one URL as clean markdown without a browser session: fast and cheap, and it handles most static and many dynamic pages. " +
    "Use it for reading articles, filings, registries, PDFs-as-pages. If it returns blocked or empty content, drive the page with run/snapshot instead. " +
    "The result is persisted as evidence with its URL: a query value that is in the URL you asked for stays in it, any other value of the final URL is replaced by a redaction marker (the word redacted in square brackets).",
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

export const BROWSER_TOOLS: readonly ToolContract[] = Object.freeze([snapshot, run, screenshot, browserRead, browserRelease, browserRelaunch, browserRequestHandoff, browserDownloads, browserUpload]);
export const WEB_TOOLS: readonly ToolContract[] = Object.freeze([webFetch, webSearch]);

export const BROWSER_TOOL_NAMES = Object.freeze(BROWSER_TOOLS.map((tool) => tool.name));
export const WEB_TOOL_NAMES = Object.freeze(WEB_TOOLS.map((tool) => tool.name));

/** Depends only on configuration, never live state, so every request renders the same text and keeps the prompt cache. */
export function browserSection(policy: { readonly idleReleaseS: number }, offered: { readonly downloads?: boolean; readonly upload?: boolean } = {}): string {
  const idle = Math.round(policy.idleReleaseS);
  const download = offered.downloads
    ? " A file the page offers as a download: click its link, then call browser_downloads, which copies it into the workspace under downloads/ (listed in downloads/manifest.json); open it with read."
    : " A file the page offers as a download cannot be collected from the browser: take the link's URL from the page and fetch it with `web_fetch` when that tool is offered, or cite the page that links it.";
  return [
    "You control one remote browser:",
    "- snapshot: the active page's accessibility tree, with bracketed element IDs for run actions.",
    "- run: snapshot actions by ID, or JavaScript against the Playwright-shaped page API. Pass exactly one of code or actions; every action uses \"op\" and \"id\", never \"kind\" or \"ref\".",
    "- screenshot: the rendered page as an image.",
    "- browser_read: the current page's content, filed as evidence with its URL.",
    "- browser_relaunch: a fresh session, Verified or egressing from a given place.",
    "- browser_release: release the session when you are done browsing.",
    ...(offered.downloads ? ["- browser_downloads: copy the files this session downloaded into the workspace, each with its SHA-256."] : []),
    ...(offered.upload ? ["- browser_upload: choose a workspace file in a file input on the page."] : []),
    "",
    "Snapshot IDs are valid only for the latest snapshot of the active page; snapshot again after navigation or a stale ID. Use snapshot actions for single clicks and fills, and one run code call for a multi-step workflow that returns only the values you need. Do not launch another browser; open more tabs with context.newPage() inside run code.",
    "",
    "The `run` page is Playwright-shaped, not Playwright. On this browser these throw: `page.waitForEvent(\"download\")`, `page.route`, `page.waitForResponse`, `context.newCDPSession`, and `page.on` for `pageerror`, `framenavigated` or `response`. Wait for what the page shows instead (`page.waitForSelector`, `page.waitForLoadState`, or poll `page.url()` or a locator's text in a short loop), read results from the page itself (a locator's text, then `browser_read` to cite it), and never intercept or rewrite requests." + download,
    "",
    // A page call made while a submit's navigation commits throws -32000 or hangs; a bounded wait and one retry avoid
    // it.
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
