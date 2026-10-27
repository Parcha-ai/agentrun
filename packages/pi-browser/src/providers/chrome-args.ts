// The arguments the cdp provider starts a local Chrome with, in one place, so a host that starts its own Chrome for Stagehand can
// take the same list rather than copy it.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserFailureError } from "../core/custody.js";
import { browserFailure } from "../core/failures.js";
import { nonEmpty } from "./shared.js";

/** Stagehand 4.1.0's DEFAULT_CHROME_FLAGS (packages/sdk-ts/src/browser/localBrowser.ts, MIT, see NOTICE), less its
 *  `--remote-allow-origins=*`, which the launch below narrows to the extension's own Origin. Without them
 *  Stagehand.create takes about 24 s on a local Chrome instead of under 100 ms. */
const CHROME_FLAGS: readonly string[] = [
  "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4,RenderDocument",
  "--disable-component-extensions-with-background-pages",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-client-side-phishing-detection",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--mute-audio",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-ipc-flooding-protection",
  "--password-store=basic",
  "--use-mock-keychain",
  "--force-fieldtrials=*BackgroundTracing/default/",
  "--disable-hang-monitor",
  "--disable-prompt-on-repost",
  "--disable-domain-reliability",
  "--propagate-iph-for-testing",
  "--enable-unsafe-extension-debugging",
  "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
];

/** The directory Stagehand loads its extension from in a local Chrome (`Extensions.loadUnpacked`), resolved as Stagehand does. */
export function extensionDirectory(): string {
  return nonEmpty(process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH) || path.join(path.dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "extension");
}

/** The Origin the extension's own DevTools socket carries. Chrome names an unpacked extension by the SHA-256 of its real path: the
 *  first 32 hex digits, each written as a letter a to p. A directory that cannot be resolved refuses the launch: the socket is never
 *  opened to every Origin instead. */
export function extensionOrigin(directory: string = extensionDirectory()): string {
  let real: string;
  try { real = realpathSync(directory); } catch (error) {
    throw new BrowserFailureError(browserFailure("browser_unavailable", `Stagehand's extension directory ${directory} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? "unreadable"}), so the browser's DevTools socket cannot be limited to the extension's Origin; no browser was started.`));
  }
  const hex = createHash("sha256").update(real).digest("hex").slice(0, 32);
  return `chrome-extension://${[...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("")}`;
}

/** Every argument a local Chrome is started with, but the page to open. The DevTools socket is the whole browser: Stagehand's own
 *  launcher allows every Origin (`*`), so a page the agent visits could drive the browser if it learned the socket's URL. Only the
 *  extension's socket carries an Origin (Node's clients send none), so only that Origin is allowed. `extensionDir`: the directory the
 *  browser will load the extension from, when it is not Stagehand's own (the cdp provider's per-lease copy). */
export function chromeArgs(options: { userDataDir: string; viewport: { width: number; height: number }; headless?: boolean; sandbox: boolean; extensionDir?: string }): string[] {
  return [
    ...CHROME_FLAGS, ...(options.sandbox ? [] : ["--no-sandbox"]), ...(options.headless ? ["--headless=new"] : []),
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--remote-allow-origins=${extensionOrigin(options.extensionDir)}`,
    `--user-data-dir=${options.userDataDir}`, `--window-size=${options.viewport.width},${options.viewport.height}`,
  ];
}
