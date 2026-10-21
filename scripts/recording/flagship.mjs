// The flagship's six documents (draft 55): train.progress, train.render, train.checkpoints, train.sweeps, body.design and
// learn.curve. Each is a durable document a tool writes through the session's store, its value one flat record with one
// `basis` for the whole document. The validator checks each revision's shape, the basis enum and the unit rule, that a
// blob is a file of the recording with an extension the document allows, that a conversation, thread or checkpoint it
// names is in the recording, and that a place's box and host are labels the recording itself gave. `see` is shown each
// line in file order; `check` then adds the problems, each at its line.

export const FLAGSHIP_DOCUMENTS = new Set(['train.progress', 'train.render', 'train.checkpoints', 'train.sweeps', 'body.design', 'learn.curve']);
export const BASIS = new Set(['measured', 'scripted', 'unmeasured', 'agent', 'simulated', 'reported']);
export const PLACE_KINDS = new Set(['local', 'daytona', 'modal', 'archil', 'tab']);
const PLACE_FIELDS = new Set(['environment', 'kind', 'host', 'box']);
const RENDERS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm']);
const BODIES = new Set(['json', 'txt', 'md']);
const SHA256 = /^[0-9a-f]{64}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value) => Number.isInteger(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
// Plain text: a string with no control character, at most `max` characters.
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL.test(value);
const KEY = (key) => text(String(key ?? ''), 64);

/** A checker for one recording: `see(event, line)` for every line in order, then `check(add, extensionsOf)`. */
export function flagshipChecker() {
  const revisions = [];
  const conversations = new Set();
  const boxes = new Set();
  const hosts = new Set();
  const checkpoints = new Set();
  return {
    see(event, line) {
      if (event.conv !== undefined) conversations.add(event.conv);
      const data = event.data;
      if (event.source === 'host' && event.kind === 'box.receipt' && typeof data?.box === 'string') boxes.add(data.box);
      // A box.created line is a label only once it carries box-N (draft 39); before that it carried the provider's own id.
      if (event.kind === 'box.created' && /^box-\d+$/.test(data?.box ?? '')) boxes.add(data.box);
      if (event.source === 'host' && event.kind === 'run.json' && typeof data?.holder?.host === 'string') hosts.add(data.holder.host);
      if (event.channel === 'durable' && isObject(data) && FLAGSHIP_DOCUMENTS.has(data.doc)) {
        revisions.push({ line, doc: data.doc, key: data.key, value: data.value });
        if (data.doc === 'train.checkpoints' && data.value !== null && data.value !== undefined) checkpoints.add(String(data.key));
      }
    },
    check(add, extensionsOf) {
      for (const { line, doc, key, value } of revisions) {
        // A deleted document (no value) has nothing to check.
        if (value === null || value === undefined) continue;
        const problem = (message) => add('events.jsonl', `${doc} ${JSON.stringify(key)}: ${message}`, line);
        if (!isObject(value)) { problem('its value is not a record'); continue; }
        for (const message of valueProblems(doc, key, value, { conversations, boxes, hosts, checkpoints, extensionsOf })) problem(message);
      }
    },
  };
}

/** The problems of one flagship document's value, given what the recording holds. */
function valueProblems(doc, key, value, known) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const measured = value.basis === 'measured';
  if (value.basis !== undefined) need(BASIS.has(value.basis), `basis ${JSON.stringify(value.basis)} is not one of ${[...BASIS].join(', ')}`);
  const conversation = (id, what) => {
    const n = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
    need(isInt(n) && known.conversations.has(n), `${what} ${JSON.stringify(id)} names no conversation in this recording`);
  };
  const checkpoint = (id, required) => {
    if (id === undefined && !required) return;
    need(typeof id === 'string' && known.checkpoints.has(id), `checkpoint ${JSON.stringify(id)} names no train.checkpoints key in this recording`);
  };
  const unit = (value, what, required) => {
    if (value === undefined) need(!required, `${what} has no unit, and its basis is measured`);
    else need(text(value, 24), `${what}'s unit is not plain text of at most 24 characters`);
  };
  const blob = (hash, allowed) => {
    if (!SHA256.test(hash ?? '')) { out.push('its blob is not a SHA-256'); return undefined; }
    const extensions = known.extensionsOf(hash);
    if (!extensions.length) { out.push(`its blob ${hash} is not in blobs/`); return undefined; }
    const ext = extensions.find((each) => allowed.has(each));
    need(ext !== undefined, `its blob ${hash} is a ${extensions.join(' or ')} file, not one of ${[...allowed].join(', ')}`);
    return ext;
  };
  const place = (value) => {
    if (!isObject(value)) { out.push('its place is not { environment?, kind?, host?, box? }'); return; }
    for (const field of Object.keys(value)) need(PLACE_FIELDS.has(field), `its place holds ${field}: a place keeps only environment, kind, host and box, never an id, a path or a machine name`);
    if (value.environment !== undefined) need(text(value.environment, 64), 'its place\'s environment is not plain text');
    if (value.kind !== undefined) need(PLACE_KINDS.has(value.kind), `its place's kind ${JSON.stringify(value.kind)} is not one of ${[...PLACE_KINDS].join(', ')}`);
    if (value.host !== undefined) need(/^host-\d+$/.test(value.host ?? '') && known.hosts.has(value.host), `its place's host ${JSON.stringify(value.host)} is not a host-N label of a run.json holder in this recording`);
    if (value.box !== undefined) need(/^box-\d+$/.test(value.box ?? '') && known.boxes.has(value.box), `its place's box ${JSON.stringify(value.box)} is not a box-N label of a box line in this recording`);
  };
  switch (doc) {
    case 'train.progress':
      conversation(key, 'its key');
      need(isInt(value.step) && value.step >= 0, 'its step is not an integer of at least 0');
      if (value.steps_total !== undefined) need(isInt(value.steps_total) && isInt(value.step) && value.steps_total >= value.step, 'its steps_total is not an integer of at least its step');
      need(finite(value.reward), 'its reward is not a finite number');
      unit(value.unit, 'its reward', measured);
      need(text(value.skill, 60), 'its skill is not plain text of at most 60 characters');
      checkpoint(value.checkpoint, false);
      break;
    case 'train.render': {
      conversation(key, 'its key');
      blob(value.blob, RENDERS);
      // Every render has its size, a video's too: its writer knows it.
      for (const side of ['w', 'h']) need(isInt(value[side]) && value[side] > 0, `its ${side} is not an integer above 0`);
      if (value.step !== undefined) need(isInt(value.step) && value.step >= 0, 'its step is not an integer of at least 0');
      checkpoint(value.checkpoint, false);
      break;
    }
    case 'train.checkpoints':
      need(KEY(key), 'its key is not plain text of at most 64 characters');
      conversation(value.thread, 'its thread');
      need(isInt(value.step) && value.step >= 0, 'its step is not an integer of at least 0');
      place(value.place);
      if (value.bytes !== undefined) need(isInt(value.bytes) && value.bytes >= 0, 'its bytes is not an integer of at least 0');
      break;
    case 'train.sweeps':
      need(KEY(key), 'its key is not plain text of at most 64 characters');
      checkpoint(value.checkpoint, true);
      need(isInt(value.rollouts) && value.rollouts > 0, 'its rollouts is not an integer above 0');
      need(finite(value.score), 'its score is not a finite number');
      unit(value.unit, 'its score', measured);
      place(value.place);
      if (value.placer !== undefined) need(value.placer === 'jev', `its placer ${JSON.stringify(value.placer)} is not "jev"`);
      break;
    case 'body.design':
      need(KEY(key), 'its key is not plain text of at most 64 characters');
      blob(value.blob, BODIES);
      need(text(value.label, 60), 'its label is not plain text of at most 60 characters');
      if (value.language !== undefined) need(text(value.language, 24), 'its language is not plain text of at most 24 characters');
      break;
    case 'learn.curve': {
      need(KEY(key), 'its key is not plain text of at most 64 characters');
      for (const axis of ['x', 'y']) {
        const at = value[axis];
        if (!isObject(at)) { out.push(`its ${axis} is not { label, unit }`); continue; }
        need(text(at.label, 40), `its ${axis} label is not plain text of at most 40 characters`);
        unit(at.unit, `its ${axis} axis`, axis === 'y' && measured);
      }
      const points = value.points;
      if (!Array.isArray(points) || points.length < 2 || points.length > 2000) { out.push('its points are not 2 to 2,000 pairs'); break; }
      let last = -Infinity;
      points.forEach((point, at) => {
        if (!Array.isArray(point) || point.length !== 2) { out.push(`its point ${at} is not a pair [x, y]`); return; }
        const [x, y] = point;
        if (!finite(x)) out.push(`its point ${at} has an x that is not a finite number`);
        else if (x < last) out.push(`its point ${at}'s x ${x} is below the one before it, ${last}`);
        else last = x;
        // A null y is a gap; any other y is a finite number.
        if (y !== null && !finite(y)) out.push(`its point ${at} has a y that is neither a finite number nor null`);
      });
      break;
    }
  }
  return out;
}
