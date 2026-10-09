// Draw the take's creature on the sketcher with real mouse events, the way a person would, for a recorder that drives the STAGE page
// over CDP while the tab sits in an iframe. The plan comes from the page after every stroke (src/strokes.ts), so a rounded drag or a
// clamp cannot leave it drawing the wrong thing; the strokes are eased, overshoot a little, and rest between each, with the creature
// rebuilding live (standing, then flopping) as it is drawn. When nothing is left to draw the design is committed to the disk.
//
//   import { sketchTake } from './sketch-take.mjs';
//   const r = await sketchTake(tab, { log });   // tab: { send(method, params), eval(expression) } of the page that holds the iframe
//   // r = { design, mjcf_sha256, strokes: ["length", "leg0", ...], undrawable: [] }
//
// Options: target (a Design, default TAKE_DESIGN), style ("human" | "direct"), stepMs (between pointer moves), restMs (between strokes),
// frame (CSS selector of the iframe, default "iframe"), settleMs (wait before the first stroke).
import { nextStroke, pathPoints, TAKE_DESIGN, undrawable } from '../src/strokes.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { TAKE_DESIGN };

export async function sketchTake(tab, { log = () => {}, target = TAKE_DESIGN, style = 'human', stepMs = 22, restMs = 450, settleMs = 0, frame = 'iframe', maxStrokes = 14 } = {}) {
  const inFrame = (expr) => `(() => { const f = document.querySelector(${JSON.stringify(frame)}); if (!f) throw new Error('no ${frame} in the stage page'); const w = f.contentWindow; ${expr} })()`;
  const geometry = async () => JSON.parse(await tab.eval(`JSON.stringify(${inFrame(`
    const fr = f.getBoundingClientRect(); const g = w.__walks.sketchGeometry();
    return { frame: { left: fr.left, top: fr.top, sx: fr.width / w.innerWidth, sy: fr.height / w.innerHeight }, ...g };`)})`));
  const mouse = (type, x, y) => tab.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' || type === 'mouseMoved' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });

  if (settleMs) await sleep(settleMs);
  const strokes = [];
  for (let n = 0; n < maxStrokes; n++) {
    const g = await geometry();
    const stroke = nextStroke(g, target);
    if (!stroke) break;
    // canvas pixels -> the stage page's pixels: the canvas's place in its page, then the iframe's place in the stage
    const toStage = (p) => ({ x: g.frame.left + g.frame.sx * (g.rect.left + p.x), y: g.frame.top + g.frame.sy * (g.rect.top + p.y) });
    const pts = pathPoints(stroke, style).map(toStage);
    log(`stroke ${strokes.length + 1}: drag the ${stroke.handle} handle`);
    await mouse('mouseMoved', pts[0].x, pts[0].y);
    await sleep(stepMs * 3); // hover before pressing
    await mouse('mousePressed', pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) { await mouse('mouseMoved', p.x, p.y); await sleep(stepMs); }
    await mouse('mouseReleased', pts[pts.length - 1].x, pts[pts.length - 1].y);
    strokes.push(stroke.handle);
    await sleep(restMs);
    // a stroke that did not move the design must not be replayed forever: say which handle did nothing
    const after = await geometry();
    if (JSON.stringify(after.design) === JSON.stringify(g.design)) throw new Error(`the ${stroke.handle} stroke did not change the design (handle at ${Math.round(stroke.from.x)},${Math.round(stroke.from.y)} in the canvas): is the sketcher visible and the iframe selector right?`);
  }
  // Out of strokes with work left is a failure, never a result: nothing is committed and the caller is told which handle was still to draw.
  const leftToDraw = nextStroke(await geometry(), target);
  if (leftToDraw) throw new Error(`stopped after ${strokes.length} strokes (maxStrokes ${maxStrokes}) with the ${leftToDraw.handle} handle still to draw: the drawing is not finished and was not committed`);
  // the pen is down for good: the creature is rebuilt and the files are written now rather than after the usual rest
  await tab.eval(`${inFrame('return w.__walks.commitDesign();')}`);
  const state = JSON.parse(await tab.eval(`JSON.stringify(${inFrame('return w.__walks.state();')})`));
  const final = await geometry();
  const left = undrawable(final.design, target);
  log(`drawn in ${strokes.length} strokes (${strokes.join(', ')}); body ${state.mjcf_sha256.slice(0, 8)}`);
  return { design: final.design, mjcf_sha256: state.mjcf_sha256, strokes, undrawable: left };
}

// run directly: node sketch-take.mjs <stage url with ?clean=1>   (needs Chrome on CDP_PORT; plays the take's drawing and prints the result)
if (import.meta.url === `file://${process.argv[1]}`) {
  const WebSocket = (await import('ws')).default;
  const port = process.env.CDP_PORT ?? 9222;
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.once('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  const call = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await call('Target.createTarget', { url: process.argv[2], width: 1600, height: 900 });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, sessionId);
  const tab = {
    send: (m, p) => call(m, p, sessionId),
    eval: async (expression) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; },
  };
  await sleep(4000);
  console.log(JSON.stringify(await sketchTake(tab, { log: console.error }), null, 1));
  await call('Target.closeTarget', { targetId });
  ws.close();
}
