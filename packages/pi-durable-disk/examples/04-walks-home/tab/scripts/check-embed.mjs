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
// What the agent would write on its own machine with the documented schema (MEMORY_SCHEMA).
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
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: Number(process.env.W ?? 1400), height: Number(process.env.H ?? 800) });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  try {
    await S('Page.enable'); await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1400), height: Number(process.env.H ?? 800), deviceScaleFactor: 1, mobile: false });
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
      await ev("sendToTab({ type: 'load-policy', url: '/policy/missing.json' })"); await sleep(500);
      r.missingPolicyError = await inner("document.getElementById('err').textContent");
      const t1 = await inner('__walks.app.sim.time'); await sleep(700);
      r.simAdvancedAfterRefusal = (await inner('__walks.app.sim.time')) > t1;
      r.policyAfterRefusal = await inner('__walks.app.policyName');
      await ev("sendToTab({ type: 'kick', dir: [0, 1], force_n: 60 })");
      await sleep(5000);
      await ev(`disk['creature/memory.sqlite'] = new Uint8Array(${JSON.stringify(agentBytes)})`); // the agent wrote a row meanwhile
      await ev("sendToTab({ type: 'open-memory' })"); await sleep(800);
      r.events = (await ev('events.map(e => e.type)'));
      r.diskFiles = await ev('Object.fromEntries(Object.entries(disk).map(([k, v]) => [k, v.length]))');
      r.diskWrites = await ev('diskWrites');
      r.timelineHosts = await inner("[...document.querySelectorAll('#memory .tl .host')].map(e => e.firstChild.textContent)");
      r.bodyFiles = await ev("({ xml: disk['creature/creature.xml'] ? new TextDecoder().decode(disk['creature/creature.xml']).slice(0, 18) : null, body: disk['creature/body.json'] ? Object.keys(JSON.parse(new TextDecoder().decode(disk['creature/body.json']))) : null })");
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

// A trained policy landing in work/home/policy.json while the page runs. ARRIVAL_POLICIES=<no-metadata.json>,<with-metadata.json>
async function arrivalScenario() {
  const [noMeta, withMeta] = (process.env.ARRIVAL_POLICIES ?? '').split(',');
  if (!noMeta || !withMeta) return { scenario: 'arrival', skipped: 'set ARRIVAL_POLICIES=a.json,b.json' };
  const { readFileSync } = await import('node:fs');
  const put = (text) => `disk['home/policy.json'] = new TextEncoder().encode(${JSON.stringify(text)})`;
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: Number(process.env.W ?? 700), height: Number(process.env.H ?? 500) });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  try {
    await S('Page.enable'); await S('Runtime.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 700), height: Number(process.env.H ?? 500), deviceScaleFactor: 1, mobile: false });
    await S('Page.navigate', { url: `${base}/__harness.html` });
    const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const inner = (expr) => ev(`document.getElementById('app').contentWindow.eval(${JSON.stringify(expr)})`);
    for (let i = 0; i < 150; i++) { if ((await inner("document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
    const waitEvent = async (type, since, ms = 30000) => { for (let t = 0; t < ms; t += 200) { const n = await ev(`events.slice(${since}).find(e => e.type === ${JSON.stringify(type)}) ?? null`); if (n) return n; await sleep(200); } return null; };
    const r = { scenario: 'arrival', bodyAtStart: await inner('__walks.app.policyName'), startMjcf: (await inner('__walks.app.bodySha')).slice(0, 8) };
    // 1. a file for a body that is no preset: refused, the creature keeps going
    let n = await ev('events.length');
    await ev(put(JSON.stringify({ format: 'mlp-v1', spec_version: 1, mjcf_sha256: 'a'.repeat(64) })));
    const refused = await waitEvent('policy-refused', n);
    r.refused = refused && { reason: refused.reason, via: refused.via };
    r.policyAfterRefusal = await inner('__walks.app.policyName');
    // 2. a policy with no metadata (for the 2-DOF preset): body switches, the toast says what is missing
    n = await ev('events.length');
    await ev(put(readFileSync(noMeta, 'utf8')));
    const a1 = await waitEvent('policy-arrived', n);
    r.noMetadata = a1 && { message: a1.message, host: a1.host, training_seconds: a1.training_seconds, switched_body: a1.switched_body, via: a1.via };
    // 3. a policy with provenance.host and wall_s
    n = await ev('events.length');
    await ev(put(readFileSync(withMeta, 'utf8')));
    const a2 = await waitEvent('policy-arrived', n);
    r.withMetadata = a2 && { message: a2.message, host: a2.host, training_seconds: a2.training_seconds, switched_body: a2.switched_body, installed_ms: a2.arrival_to_installed_ms };
    r.toastShown = await inner("document.getElementById('toast').textContent");
    // the stage also sends load-policy for the same file when the run is home: one arrival, not two
    const dataUrl = 'data:application/json;base64,' + Buffer.from(readFileSync(withMeta, 'utf8')).toString('base64');
    await ev(`sendToTab({ type: 'load-policy', url: ${JSON.stringify(dataUrl)} })`); await sleep(2000);
    r.arrivalsAfterDoubleAnnounce = await ev("events.filter(e => e.type === 'policy-arrived').length"); // 2: the no-metadata one and this one
    const walked = await waitEvent('policy-walked', n, 120000);
    r.walked = walked && { arrival_to_walking_ms: walked.arrival_to_walking_ms, sim_seconds_to_walking: walked.sim_seconds_to_walking, mean_speed_10s: walked.mean_speed && +walked.mean_speed.toFixed(3), fell: walked.fell };
    r.noDuplicates = (await ev("events.filter(e => e.type === 'policy-arrived').length")) === 2;
    r.hud = await inner("document.getElementById('hud').textContent");
    const shot = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${out}/embed-arrival.png`, Buffer.from(shot.data, 'base64'));
    return r;
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

try {
  if (process.env.ARRIVAL_ONLY) { console.log(JSON.stringify(await arrivalScenario(), null, 1)); process.exit(0); }
  console.log(JSON.stringify([await scenario('answering-parent', false), await scenario('silent-parent', true), await scenario('viewer-parent', false, true), await arrivalScenario()], null, 1));
} finally { ws.close(); server.close(); }
