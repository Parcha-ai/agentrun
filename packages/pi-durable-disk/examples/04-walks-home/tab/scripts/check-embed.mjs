// Embedded run: the app inside a parent page that answers storage and sends protocol messages. Checks that memory goes
// to the parent (the "disk"), a kick message makes the tab report kicked/stood, and that a silent parent falls back to
// this browser only. Own browser context, own Chrome on CDP_PORT. usage: node scripts/check-embed.mjs <outdir>
import WebSocket from 'ws';
import initSqlJs from 'sql.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const server = await serve(0);
const sql = await initSqlJs();
// What the agent would write on its own machine with the documented schema (memory-schema.sql).
const agentDb = new sql.Database();
agentDb.run('CREATE TABLE machines (id INTEGER PRIMARY KEY, at TEXT NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT "")');
agentDb.run("INSERT INTO machines (at, host, kind, note) VALUES ('2026-10-09T11:00:00Z', 'gpu:4090-3', 'gpu', 'trained reward variant 3')");
const agentBytes = Array.from(agentDb.export());
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, silent, viewer = false) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1400, height: 800 });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  try {
    await S('Page.enable'); await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 800, deviceScaleFactor: 1, mobile: false });
    // The harness must answer from the first request: set the flag before the frame loads by navigating, then flipping early.
    await S('Page.addScriptToEvaluateOnNewDocument', { source: `${silent ? 'window.__silent = true;' : ''}${viewer ? 'window.__viewer = true;' : ''}` });
    await S('Page.navigate', { url: `${base}/__harness.html` });
    const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
    let status;
    for (let i = 0; i < 150; i++) { status = await inner("document.getElementById('status')?.textContent").catch(() => null); if (status === 'ready') break; await sleep(200); }
    const r = { scenario: name, status, storage: await inner("document.getElementById('storage')?.textContent") };
    if (status !== 'ready') return r;
    if (viewer) {
      await inner("document.getElementById('build').click()"); await sleep(1500);
      r.events = await ev('events.map(e => e.type)');
      r.error = await inner("document.getElementById('err').textContent");
      r.running = await inner('__walks.app.sim.time > 1');
      r.diskFiles = await ev('Object.keys(disk)');
    } else if (!silent) {
      await ev("sendToTab({ type: 'set-placement', kind: 'daytona', label: 'Daytona sandbox' })");
      r.placement = await inner("document.getElementById('placement').textContent");
      await ev("sendToTab({ type: 'kick', dir: [0, 1], force_n: 60 })");
      await sleep(5000);
      await ev(`disk['creature/memory.sqlite'] = new Uint8Array(${JSON.stringify(agentBytes)})`); // the agent wrote a row meanwhile
      await ev("sendToTab({ type: 'open-memory' })"); await sleep(800);
      r.events = (await ev('events.map(e => e.type)'));
      r.diskFiles = await ev('Object.fromEntries(Object.entries(disk).map(([k, v]) => [k, v.length]))');
      r.diskWrites = await ev('diskWrites');
      r.timelineHosts = await inner("[...document.querySelectorAll('#memory .tl .host')].map(e => e.firstChild.textContent)");
      r.designsOnDisk = await inner("document.querySelectorAll('#memory table.designs tr').length - 1");
    }
    const shot = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${out}/embed-${name}.png`, Buffer.from(shot.data, 'base64'));
    return r;
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

try {
  console.log(JSON.stringify([await scenario('answering-parent', false), await scenario('silent-parent', true), await scenario('viewer-parent', false, true)], null, 1));
} finally { ws.close(); server.close(); }
