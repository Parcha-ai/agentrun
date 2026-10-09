// A small Chrome DevTools helper for the perf and soak scripts: one browser context, one page of this app served by
// scripts/serve.mjs, evaluate, CPU throttling and heap usage. Only this app's own page.
import WebSocket from 'ws';
import { serve } from './serve.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openApp({ port = process.env.CDP_PORT ?? 9222, width = 700, height = 500, throttle = 1, query = '' } = {}) {
  const server = await serve(0);
  const url = `http://127.0.0.1:${server.address().port}/${query}`;
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.once('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId, width, height });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable'); await S('HeapProfiler.enable');
  await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  if (throttle !== 1) await S('Emulation.setCPUThrottlingRate', { rate: throttle });
  await S('Page.navigate', { url });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  for (let i = 0; i < 200 && (await ev("document.getElementById('status')?.textContent").catch(() => null)) !== 'ready'; i++) await sleep(200);
  if ((await ev("document.getElementById('status')?.textContent")) !== 'ready') throw new Error('the page did not become ready');
  return {
    ev,
    /** Used JS heap in MB after a forced GC, so growth is not hidden by garbage. */
    async heapMB() { await S('HeapProfiler.collectGarbage'); const h = await S('Runtime.getHeapUsage'); return +(h.usedSize / 1048576).toFixed(2); },
    async screenshot(path) { const { writeFileSync } = await import('node:fs'); writeFileSync(path, Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64')); },
    async close() {
      await send('Target.closeTarget', { targetId }).catch(() => {});
      await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      ws.close(); server.close();
    },
  };
}

/** A walking-net + getup-net policy for the page's current body, recognisable by its outputs (see test/getup.test.ts). */
export async function syntheticTwoNetPolicy(ev) {
  const nj = await ev('__walks.app.built.jointNames.length');
  const b64 = (a) => Buffer.from(new Float32Array(a).buffer).toString('base64');
  const layer = (bias) => ({ in: 1, out: nj, w: b64(new Array(nj).fill(0)), b: b64(new Array(nj).fill(bias)), act: 'none' });
  return JSON.stringify({
    format: 'mlp-v1', spec_version: 1, mujoco_version: await ev('__walks.app.mujocoVersion'), mjcf_sha256: await ev('__walks.app.bodySha'), control_dt: 0.02,
    obs: { spec: [{ name: 'command', size: 1 }], mean: [0], std: [1] }, act: { scale: 0.5, clip: 1 }, layers: [layer(0)],
    getup: { layers: [layer(0.5)], act: { scale: 2, clip: 1 }, switch: { below_up: 0.3, above_up: 0.9 } },
  });
}
