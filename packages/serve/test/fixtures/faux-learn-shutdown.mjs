// A paid batch request held at a precise boundary, to distinguish a server restart from a cut runner request.
import reply from './faux-learn.mjs';
export { cost } from './faux-learn.mjs';
let held;
export function holdRow(n, { phase = "task" } = {}) {
  let entered, release, cut;
  const started = new Promise(resolve => { entered = resolve; });
  const aborted = new Promise(resolve => { cut = resolve; });
  held = { n, phase, entered, cut, used: false, released: new Promise(resolve => { release = resolve; }) };
  return { started, aborted, release };
}
export default function request(context, faux) {
  const users = context.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join(''));
  const gate = held;
  if (!gate || gate.used || users[0] !== `name: Shop ${gate.n}\nsite: shop${gate.n}.example`) return reply(context, faux);
  const lookingBack = users.at(-1)?.startsWith("The task is done. Before the run ends, ") === true;
  if (gate.phase === "task" ? users.length !== 1 : !lookingBack) return reply(context, faux);
  gate.used = true;
  gate.entered();
  return new Promise(resolve => {
    let ended = false;
    const finish = value => { if (ended) return; ended = true; faux.signal?.removeEventListener('abort', abort); resolve(value); };
    const abort = () => { gate.cut(); finish(faux.message('', { stopReason: 'aborted' })); };
    if (faux.signal?.aborted) abort();
    else {
      faux.signal?.addEventListener('abort', abort, { once: true });
      gate.released.then(() => finish(reply(context, faux)));
    }
  });
}
