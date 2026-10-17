import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";

const LOOPBACK = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 600, height: 400 }, metadata: {} });
const signal = () => new AbortController().signal;

/** The race, forced: a wrapper standing in for the Chrome binary starts a squatter Chrome on the port the provider
 *  chose, then the provider's Chrome on the same port, which cannot bind it and runs on with no debugger. */
function collidingChrome(dir) {
  const file = path.join(dir, "colliding-chrome.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
const args = process.argv.slice(2);
const real = process.env.CHROME_REAL;
const flag = (name) => args.find((a) => a.startsWith("--" + name + "="))?.split("=").slice(1).join("=");
const profile = flag("user-data-dir");
let port = Number(flag("remote-debugging-port"));
if (!port) port = await new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const withProfile = (dir) => args.map((a) => a.startsWith("--remote-debugging-port=") ? "--remote-debugging-port=" + port : a.startsWith("--user-data-dir=") ? "--user-data-dir=" + dir : a);
const squatter = spawn(real, withProfile(profile + ".squatter"), { stdio: "ignore" });
for (let i = 0; i < 100; i += 1) { try { await fetch("http://127.0.0.1:" + port + "/json/version"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
if (process.env.LIAR) {
  // No Chrome of its own: the profile claims the squatter's port with a browser path that is not the squatter's, then the process ends.
  fs.writeFileSync(profile + "/DevToolsActivePort", port + "\\n/devtools/browser/00000000-0000-0000-0000-000000000000\\n");
  await new Promise((r) => setTimeout(r, 3000));
  try { squatter.kill("SIGKILL"); } catch {}
  process.exit(1);
}
const chrome = spawn(real, withProfile(profile), { stdio: "ignore" });
const stop = () => { try { squatter.kill("SIGKILL"); } catch {} try { chrome.kill("SIGKILL"); } catch {} };
for (let i = 0; i < 30 && !fs.existsSync(profile + "/DevToolsActivePort"); i += 1) await new Promise((r) => setTimeout(r, 100));
if (!fs.existsSync(profile + "/DevToolsActivePort")) { stop(); process.exit(1); }
chrome.on("exit", () => { stop(); process.exit(0); });
`);
  chmodSync(file, 0o755);
  return file;
}

async function rig(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-ownership-"));
  const profiles = path.join(root, "a");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: profiles, args: [LOOPBACK] } });
  const leases = [];
  t.after(async () => { for (const [p, ref] of leases) await p.release(ref).catch(() => undefined); // The squatter Chrome may still be writing its profile as its process group dies: retry the removal.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }, { timeout: 30_000 });
  const lease = async (p, tag) => { const ref = await p.create(spec(tag), signal()); leases.push([p, ref]); return ref; };
  return { root, profiles, provider, lease };
}

test("a launch whose Chrome could not take its debugging port fails, instead of attaching to the browser that holds the port", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { root } = await rig(t);
  process.env.CHROME_REAL = CHROME;
  const provider = cdpProvider({ chrome: { executablePath: collidingChrome(root), profileRoot: path.join(root, "b"), args: [LOOPBACK] } });
  let ref = null, refused = null;
  try { ref = await provider.create(spec("second"), signal()); } catch (error) { refused = error; }
  if (ref) await provider.release(ref).catch(() => undefined);
  assert.ok(!ref, `create returned a lease (${ref?.id}) for a Chrome that has no debugger of its own: the browser answering on its port is another one`);
  assert.ok(refused, "create fails");
});

test("a lease never attaches to a browser other than the one its own profile records", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { provider, lease } = await rig(t);
  const one = await lease(provider, "one");
  const two = await lease(provider, "two");
  const [, pidTwo, , tagTwo] = two.id.split(":");
  const [, , portOne] = one.id.split(":");
  // Lease two's tag with the port that now belongs to lease one: what a port reused after a crash looks like.
  const crossed = { id: `local:${pidTwo}:${portOne}:${tagTwo}`, tag: tagTwo };
  await assert.rejects(provider.attach(crossed), /not the browser|different browser|does not record|not this lease/i, "attach reached another lease's browser");
});

test("a profile that records the requested port but another browser's path is refused at attach", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { profiles, provider, lease } = await rig(t);
  const one = await lease(provider, "one");
  const two = await lease(provider, "two");
  const [, pidTwo, , tagTwo] = two.id.split(":");
  const [, , portOne] = one.id.split(":");
  // Lease two's profile now says it is the browser on lease one's port, under a path that is not lease one's.
  writeFileSync(path.join(profiles, tagTwo, "DevToolsActivePort"), `${portOne}\n/devtools/browser/00000000-0000-0000-0000-000000000000\n`);
  await assert.rejects(provider.attach({ id: `local:${pidTwo}:${portOne}:${tagTwo}`, tag: tagTwo }), /not the browser/i, "attach returned the browser on the port although the profile names another one");
});

test("a launch whose profile names a browser other than the one answering on its port fails", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { root } = await rig(t);
  process.env.CHROME_REAL = CHROME;
  process.env.LIAR = "1";
  t.after(() => { delete process.env.LIAR; }, { timeout: 30_000 });
  const provider = cdpProvider({ chrome: { executablePath: collidingChrome(root), profileRoot: path.join(root, "c"), args: [LOOPBACK] } });
  let ref = null;
  try { ref = await provider.create(spec("liar"), signal()); } catch {}
  if (ref) await provider.release(ref).catch(() => undefined);
  assert.ok(!ref, `create returned a lease (${ref?.id}) for a profile whose recorded browser is not the one answering on that port`);
});

