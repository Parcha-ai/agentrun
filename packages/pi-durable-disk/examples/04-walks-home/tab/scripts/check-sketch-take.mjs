// sketchTake in the real page: the app inset in a parent (as a stage holds it), the mouse strokes played through a CDP tab object,
// then the design the page ended up with and the files on the harness's disk. CDP_PORT=9333 node scripts/check-sketch-take.mjs <outdir>
import WebSocket from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { serve } from './serve.mjs';
import { outDir } from './outdir.mjs';
import { sketchTake, TAKE_DESIGN } from './sketch-take.mjs';

const out = outDir(process.argv[2]);
mkdirSync(out, { recursive: true });
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}`;
const v = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width: 1600, height: 900 });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
try {
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: `${base}/__harness.html?clean=1&inset=1` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const tab = { send: S, eval: ev };
  for (let i = 0; i < 150; i++) { if ((await ev("document.querySelector('iframe').contentWindow.document.getElementById('status')?.textContent").catch(() => null)) === 'ready') break; await sleep(200); }
  const filesBefore = await ev("Object.keys(disk).filter((k) => k.startsWith('creature/c') || k.startsWith('creature/b'))");
  const t0 = Date.now();
  const logs = [];
  const mids = [];
  const r = await sketchTake(tab, {
    log: (l) => logs.push(l),
    // after every stroke: what the sketcher holds, and which body the live 3D creature was last rebuilt for; a still at 40% of the strokes is saved
    onStroke: async ({ handle, index, design }) => {
      await sleep(500); // the live rebuild follows the pen's rest
      const sha = await ev("document.querySelector('iframe').contentWindow.__walks.state().mjcf_sha256");
      mids.push({ index, handle, reach: +(design.legs[0].thigh + design.legs[0].shin).toFixed(3), length: design.torso.length, sha });
      if (index === 1) writeFileSync(`${out}/sketch-take-40pct.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    },
  });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  await sleep(600);
  writeFileSync(`${out}/sketch-take-end.png`, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const xml = await ev("new TextDecoder().decode(disk['creature/creature.xml'])");
  const body = JSON.parse(await ev("new TextDecoder().decode(disk['creature/body.json'])"));
  const sha = await ev(`crypto.subtle.digest('SHA-256', new TextEncoder().encode(${JSON.stringify(xml)})).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''))`);
  const state = await ev("document.querySelector('iframe').contentWindow.__walks.state()");
  const frameRect = await ev("(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { left: r.left, top: r.top, width: Math.round(r.width), height: Math.round(r.height) }; })()");
  const failures = [];
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures.push(name); };
  check('the take starts from a bare torso and is drawn in six strokes, one per thing that changes', JSON.stringify(r.strokes) === JSON.stringify(['length', 'width', 'hip0', 'hip1', 'leg0', 'leg1']), r.strokes.join(' '));
  check('the drawing ends on the take body, nothing undrawable', r.undrawable.length === 0 && r.design.torso.length === TAKE_DESIGN.torso.length && r.design.torso.width === TAKE_DESIGN.torso.width && r.design.legs.every((l, i) => l.x === TAKE_DESIGN.legs[i].x && l.thigh + l.shin === TAKE_DESIGN.legs[i].thigh + TAKE_DESIGN.legs[i].shin), JSON.stringify(r.design.torso));
  const at40 = mids[Math.floor(mids.length * 0.4) - 1];
  check('a still at 40% of the strokes is visibly partial: legs still stubs (reach under 0.3 m, final 0.5)', !!at40 && at40.reach < 0.3, JSON.stringify(at40));
  check('the legs grow in the leg strokes', mids.find((m) => m.handle === 'leg0').reach >= 0.4 && mids[mids.length - 1].reach >= 0.49, mids.map((m) => `${m.handle}:${m.reach}`).join(' '));
  check('the 3D creature was rebuilt as the drawing grew (a different body after most strokes)', new Set(mids.map((m) => m.sha)).size >= 4, `${new Set(mids.map((m) => m.sha)).size} bodies`);
  check('the creature files are on the disk and match the body on screen', body.mjcf_sha256 === state.mjcf_sha256 && sha === body.mjcf_sha256 && mids[mids.length - 1].sha === state.mjcf_sha256);
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
  if (failures.length) process.exitCode = 1;
  console.log(JSON.stringify({
    iframeInPage: frameRect, took_s: +took, logs, result: r,
    target: TAKE_DESIGN.torso, filesBeforeDrawing: filesBefore,
    filesAfter: await ev("Object.keys(disk).filter((k) => k.startsWith('creature/c') || k.startsWith('creature/b'))"),
    bodyJsonShaEqualsStateSha: body.mjcf_sha256 === state.mjcf_sha256, xmlShaEqualsBodyJsonSha: sha === body.mjcf_sha256, state: { state: state.state, phase: state.phase },
    hexHeaderStrokesCount: r.strokes.length, mids,
  }, null, 1));
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
