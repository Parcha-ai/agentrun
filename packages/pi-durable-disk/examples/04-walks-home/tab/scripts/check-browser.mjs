// Drive the built page in the machine's Chrome (CDP on 9222) in its own browser context: load, wait for ready,
// let the dummy policy run, kick, screenshot. Prints JSON of what the page reported. Only this app's own page.
// usage: node scripts/check-browser.mjs <outdir>
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const server = await serve(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const v = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT ?? 9222) + '/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map(); const events = [];
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else events.push(m); });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: Number(process.env.W ?? 1400), height: Number(process.env.H ?? 800) });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1400), height: Number(process.env.H ?? 800), deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  for (let i = 0; i < 100 && (await ev("document.getElementById('status')?.textContent")) !== 'ready'; i++) await sleep(200);
  const result = { status: await ev("document.getElementById('status')?.textContent") };
  if (result.status !== 'ready') {
    console.log(JSON.stringify({ ...result, events: events.filter((e) => /exception|console|loadingFailed/i.test(e.method)).map((e) => JSON.stringify(e.params).slice(0, 400)) }, null, 1));
    process.exitCode = 1;
    throw new Error('page did not reach ready');
  }
  const snap = (name) => S('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(`${out}/${process.env.W ?? 1400}-${name}.png`, Buffer.from(r.data, 'base64')));
  const state = () => ev("(() => { const a = __walks.app; return {t: a.sim.time, pos: a.sim.torsoPos(), up: a.sim.uprightness(), policy: a.policyName}; })()");
  result.start = await state();
  await sleep(1500); await snap('1-walking');
  await sleep(4000);
  result.walked = await state();
  await ev("__walks.kick(0, 1, 60)");
  await sleep(300); await snap('2-kicked');
  await sleep(4000);
  result.afterKick = await state();
  await ev("document.getElementById('openMemory').click()"); await sleep(300);
  await ev("document.getElementById('seedDemo')?.click()"); await sleep(500);
  result.scrollable = await ev('document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1');
  await snap('3-memory');
  result.timelineRows = await ev("document.querySelectorAll('#memory .tl li').length");
  result.consoleErrors = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')).map((e) => JSON.stringify(e.params).slice(0, 300));
  console.log(JSON.stringify(result, null, 1));
  await send('Target.closeTarget', { targetId });
} finally {
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
