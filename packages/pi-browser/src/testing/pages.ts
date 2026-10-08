// Fixture pages that carry secrets the way real pages do, for the wire check: a debug page that prints the connect
// URL it was reached with, and an authenticator enrollment page that shows the TOTP seed.
import { fixturePage, type FixturePage } from "./backend.js";
import type { Sentinels } from "./sentinels.js";

export function sentinelPages(s: Sentinels): Record<string, FixturePage> {
  const at = (url: string, text: string, title: string) => [url, fixturePage(url, text, title)] as const;
  return Object.fromEntries([
    at("https://login.sentinel.test/", "Sign in. Username, password.", "Sign in"),
    at("https://login.sentinel.test/enroll", `Scan the code or type this key into your authenticator: ${s.totpSeed.match(/.{1,4}/g)?.join(" ")} (${s.totpSeed})`, "Set up two-factor"),
    at("https://debug.sentinel.test/", `upstream debug: ${s.bbConnectUrl} and ${s.kernelCdpUrl}`, "Upstream error"),
    at("https://example.test/article", "An article with nothing secret in it.", "Article"),
  ]);
}
