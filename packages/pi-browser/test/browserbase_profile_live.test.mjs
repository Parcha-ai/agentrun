// Live: opens real Browserbase sessions and one context, a few cents. Off unless PI_BROWSER_LIVE=1 with a key in the env.
import assert from "node:assert/strict";
import test from "node:test";
import { browserbaseProvider } from "../dist/providers/browserbase.js";
import { withPage } from "./fixtures/cdp-page.mjs";

const LIVE = process.env.PI_BROWSER_LIVE === "1" && Boolean(process.env.BROWSERBASE_API_KEY);
const spec = (tag, profile) => ({ tag, maxLifetimeS: 300, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1288, height: 711 }, metadata: { agentrun: "profile-live" }, ...(profile ? { profile } : {}) });
const signal = () => new AbortController().signal;
const rows = new Map();
const store = { resolve: async (key, make) => { if (!rows.has(key)) rows.set(key, await make()); return rows.get(key); } };

test("a Browserbase profile saved in session 1 is still there in session 2", { skip: LIVE ? false : "set PI_BROWSER_LIVE=1 and BROWSERBASE_API_KEY", timeout: 240_000 }, async (t) => {
  const provider = browserbaseProvider({ env: process.env, profiles: store, ...(process.env.PI_BROWSER_PROFILE_SETTLE_MS ? { profileSettleMs: Number(process.env.PI_BROWSER_PROFILE_SETTLE_MS) } : {}) });
  const name = `live-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const token = `t${Math.random().toString(36).slice(2, 12)}`;
  const refs = [];
  const run = async (tag, profile, work) => {
    const ref = await provider.create(spec(tag, profile), signal());
    refs.push(ref);
    try {
      const target = await provider.attach(ref);
      return await withPage(target.sdkCdpUrl, "https://example.com/", work);
    } finally { await provider.release(ref); }
  };
  t.after(async () => {
    const id = [...rows.values()][0];
    if (!id) return;
    const { default: Browserbase } = await import("@browserbasehq/sdk");
    await new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY }).contexts.delete(id).catch(() => undefined);
  });
  await run(`ar-live-bb-${process.pid}-1`, { name, save: true }, (evaluate) => evaluate(`document.cookie = "pi_probe=${token}; max-age=3600; path=/"; document.cookie`));
  assert.equal(rows.size, 1, "one context was made for the name");
  const seen = await run(`ar-live-bb-${process.pid}-2`, { name, save: true }, (evaluate) => evaluate("document.cookie"));
  assert.match(seen, new RegExp(`pi_probe=${token}`), "session 2 has the cookie session 1 saved");
  const other = await run(`ar-live-bb-${process.pid}-3`, undefined, (evaluate) => evaluate("document.cookie"));
  assert.doesNotMatch(other, /pi_probe/, "a session with no profile is a fresh browser");
  assert.equal(rows.size, 1, "and the name kept its one context");
});
