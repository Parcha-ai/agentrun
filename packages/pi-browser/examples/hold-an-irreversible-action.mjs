// Hold an irreversible action. Under actions "ask" the browser holds every request that changes something until a person
// approves it. Here a page posts a form to a local server; the decision below says no, so the server sees nothing.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EffectObserver, effectDecider } from "@parcha/pi-browser";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";

let posts = 0;
const server = http.createServer((req, res) => { if (req.method === "POST") posts += 1; res.setHeader("content-type", "text/html"); res.end('<form method="post"><button>Delete my account</button></form>'); }).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const root = await mkdtemp(join(tmpdir(), "pi-browser-"));
const provider = cdpProvider({ chrome: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", profileRoot: root } });
let session;
try {
  const signal = AbortSignal.timeout(120_000);
  session = await provider.create({ tag: "hold-demo", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, signal);
  const target = await provider.attach(session);
  const ask = effectDecider("ask", { approveEffect: async (request) => { console.log(`held ${request.method} ${request.path}: refused`); return false; } });
  const observer = await EffectObserver.open(target, ask);
  const driver = await stagehandDriver()(target, signal);
  await driver.run({ code: `await page.goto("http://127.0.0.1:${server.address().port}/"); await page.getByRole("button", { name: "Delete my account" }).click();` });
  await observer.flush();
  console.log(`posts that reached the server: ${posts}`);
  observer.close(); await driver.close();
} finally {
  if (session) await provider.release(session);
  server.close(); await rm(root, { recursive: true, force: true });
}
