// Live: opens real Kernel browsers and one profile, a few cents. Off unless PI_BROWSER_LIVE=1 with KERNEL_API_KEY in the env.
import assert from "node:assert/strict";
import test from "node:test";
import { kernelProvider } from "../dist/providers/kernel.js";
import { withPage } from "./fixtures/cdp-page.mjs";

const LIVE = process.env.PI_BROWSER_LIVE === "1" && Boolean(process.env.KERNEL_API_KEY);
const spec = (tag, profile) => ({ tag, maxLifetimeS: 300, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1288, height: 711 }, metadata: { agentrun: "profile-live" }, ...(profile ? { profile } : {}) });
const signal = () => new AbortController().signal;

test("a Kernel profile saved in browser 1 is still there in browser 2", { skip: LIVE ? false : "set PI_BROWSER_LIVE=1 and KERNEL_API_KEY", timeout: 240_000 }, async (t) => {
  const provider = kernelProvider({ env: process.env });
  const name = `live-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const token = `t${Math.random().toString(36).slice(2, 12)}`;
  const base = (process.env.KERNEL_BASE_URL || "https://api.onkernel.com").replace(/\/+$/, "");
  t.after(() => fetch(`${base}/profiles/${encodeURIComponent(name)}`, { method: "DELETE", headers: { authorization: `Bearer ${process.env.KERNEL_API_KEY}` } }).catch(() => undefined));
  const run = async (tag, profile, work) => {
    const ref = await provider.create(spec(tag, profile), signal());
    try {
      const target = await provider.attach(ref);
      return await withPage(target.sdkCdpUrl, "https://example.com/", work);
    } finally { await provider.release(ref); }
  };
  await run(`ar-live-k-${process.pid}-1`, { name, save: true }, (evaluate) => evaluate(`document.cookie = "pi_probe=${token}; max-age=3600; path=/"; document.cookie`));
  const seen = await run(`ar-live-k-${process.pid}-2`, { name, save: true }, (evaluate) => evaluate("document.cookie"));
  assert.match(seen, new RegExp(`pi_probe=${token}`), "browser 2 has the cookie browser 1 saved");
  const other = await run(`ar-live-k-${process.pid}-3`, undefined, (evaluate) => evaluate("document.cookie"));
  assert.doesNotMatch(other, /pi_probe/, "a browser with no profile is a fresh one");
});
