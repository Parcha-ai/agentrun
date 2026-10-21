// The flagship's documents (draft 55 and its amendments 1 and 2): train.progress, train.render, train.checkpoints,
// train.sweeps, body.design, learn.curve, body.run, body.render and placement. Each is a durable document a tool writes through the session's store, its value one flat record with one
// `basis` for the whole document. The validator checks each revision's shape, the basis enum and the unit rule, that a
// blob is a file of the recording with an extension the document allows, that a conversation, thread or checkpoint it
// names is in the recording, and that a place's box and host are labels the recording itself gave. `see` is shown each
// line in file order; `check` then adds the problems, each at its line.

export const FLAGSHIP_DOCUMENTS = new Set(['train.progress', 'train.render', 'train.checkpoints', 'train.sweeps', 'body.design', 'learn.curve', 'body.run', 'body.render', 'placement']);
const PLACERS = new Set(['jev', 'config']);
const PHASES = new Set(['message', 'turn_end']);
/** The placement rule the validator knows, and checks against the record's own inputs (amendment 2). */
const NEED_THRESHOLD = 'transport.need-threshold/1';
/** A distribution's probabilities sum to 1 within this (amendment 2). */
const SUM_SLACK = 0.02;
const STATUS = new Set(['running', 'compiled', 'done', 'failed', 'refused']);
const DIAGNOSIS = new Set(['never-moved', 'plateaued', 'never-settles', 'never-measured', 'still-changing', 'test-raised', 'no-checkpoint', 'too-few-checkpoints']);
const RUN_KINDS = new Set(['build', 'stand', 'skill']);
const BODY_RENDERS = new Set(['png', 'webp', 'webm']);
/** A body render is a clip of at most 600 KB (amendment 1). */
const BODY_RENDER_BYTES = 600_000;
const BODY_ID = /^b-[0-9a-f]{8}$/;
const OPS = new Map([['>=', (a, b) => a >= b], ['<=', (a, b) => a <= b], ['>', (a, b) => a > b], ['<', (a, b) => a < b]]);
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

/** A checker for one recording: `see(event, line)` for every line in order, then `check(add, extensionsOf, sizeOf)`. */
export function flagshipChecker() {
  const revisions = [];
  const conversations = new Set();
  const boxes = new Set();
  const hosts = new Set();
  const checkpoints = new Set();
  const placements = new Set();
  const documents = new Set();
  const calls = new Set();
  return {
    see(event, line) {
      if (event.conv !== undefined) conversations.add(event.conv);
      const data = event.data;
      if (event.source === 'host' && event.kind === 'box.receipt' && typeof data?.box === 'string') boxes.add(data.box);
      // A box.created line is a label only once it carries box-N (draft 39); before that it carried the provider's own id.
      if (event.kind === 'box.created' && /^box-\d+$/.test(data?.box ?? '')) boxes.add(data.box);
      if (event.source === 'host' && event.kind === 'run.json' && typeof data?.holder?.host === 'string') hosts.add(data.holder.host);
      if (event.channel === 'durable' && isObject(data) && typeof data.doc === 'string' && data.value !== null && data.value !== undefined) documents.add(`${data.doc}\u0000${data.key}`);
      if (event.kind === 'pi.assistant') for (const message of Array.isArray(data?.model) ? data.model : []) for (const part of Array.isArray(message?.content) ? message.content : []) if (part?.type === 'toolCall' && typeof part.id === 'string') calls.add(part.id);
      if (event.channel === 'durable' && isObject(data) && FLAGSHIP_DOCUMENTS.has(data.doc)) {
        revisions.push({ line, doc: data.doc, key: data.key, value: data.value });
        if (data.doc === 'train.checkpoints' && data.value !== null && data.value !== undefined) checkpoints.add(String(data.key));
        if (data.doc === 'placement' && data.value !== null && data.value !== undefined) placements.add(String(data.key));
      }
    },
    check(add, extensionsOf, sizeOf = () => 0) {
      for (const { line, doc, key, value } of revisions) {
        // A deleted document (no value) has nothing to check.
        if (value === null || value === undefined) continue;
        const problem = (message) => add('events.jsonl', `${doc} ${JSON.stringify(key)}: ${message}`, line);
        if (!isObject(value)) { problem('its value is not a record'); continue; }
        for (const message of valueProblems(doc, key, value, { conversations, boxes, hosts, checkpoints, placements, documents, calls, extensionsOf, sizeOf })) problem(message);
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
  const nonNegative = (v) => finite(v) && v >= 0;
  const probability = (v) => finite(v) && v >= 0 && v <= 1;
  // A document a placer placed names its placement beside its placer (amendment 2).
  const placedBy = (v) => {
    if (v.placement !== undefined) need(typeof v.placement === 'string' && known.placements.has(v.placement), `its placement ${JSON.stringify(v.placement)} names no placement in this recording`);
  };
  const label = (v, what, max = 60) => need(text(v, max), `its ${what} is not plain text of at most ${max} characters`);
  const metric = (m) => {
    if (!isObject(m)) { out.push('its metric is not { name, value, unit?, target? }'); return; }
    need(text(m.name, 24), 'its metric\'s name is not plain text of at most 24 characters');
    // A null value is a gap: the test did not measure it (fix 1). Never 0.
    need(m.value === null || finite(m.value), 'its metric\'s value is neither a finite number nor null');
    unit(m.unit, 'its metric', measured);
    if (m.target !== undefined) need(isObject(m.target) && OPS.has(m.target.op) && finite(m.target.value), `its metric's target is not { op (${[...OPS.keys()].join(', ')}), value (a finite number) }`);
  };
  // passes is one-way (fix 1): a pass is on target, so true needs value op target.value; false may be on target, as a
  // skill's test has more conditions than its metric. With no numeric target or a null value the check does not run.
  const passes = (v) => {
    if (v.passes !== undefined) need(typeof v.passes === 'boolean', 'its passes is not true or false');
    const m = v.metric, target = isObject(m) ? m.target : undefined;
    if (v.passes !== true || !finite(m?.value) || !isObject(target) || !OPS.has(target.op) || !finite(target.value)) return;
    need(OPS.get(target.op)(m.value, target.value), `its passes is true, but its metric ${m.value} is not ${target.op} ${target.value}`);
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
      // An absent reward is absent (amendment 1): it never downgrades the document's other numbers.
      if (value.reward !== undefined) { need(finite(value.reward), 'its reward is not a finite number'); unit(value.unit, 'its reward', measured); }
      need(text(value.skill, 60), 'its skill is not plain text of at most 60 characters');
      checkpoint(value.checkpoint, false);
      if (value.metric !== undefined) metric(value.metric);
      passes(value);
      if (value.t_s !== undefined) need(nonNegative(value.t_s), 'its t_s is not a number of seconds of at least 0');
      if (value.status !== undefined) need(STATUS.has(value.status), `its status ${JSON.stringify(value.status)} is not one of ${[...STATUS].join(', ')}`);
      if (value.passed_at !== undefined) {
        if (!isObject(value.passed_at)) out.push('its passed_at is not { checkpoint, step, t_s }');
        else {
          checkpoint(value.passed_at.checkpoint, true);
          need(isInt(value.passed_at.step) && value.passed_at.step >= 0, 'its passed_at step is not an integer of at least 0');
          need(nonNegative(value.passed_at.t_s), 'its passed_at t_s is not a number of seconds of at least 0');
        }
      }
      if (value.diagnosis !== undefined) {
        if (!isObject(value.diagnosis)) out.push('its diagnosis is not { kind, text }');
        else {
          need(DIAGNOSIS.has(value.diagnosis.kind), `its diagnosis kind ${JSON.stringify(value.diagnosis.kind)} is not one of ${[...DIAGNOSIS].join(', ')}`);
          // The trainer's own sentence, shown and never parsed.
          if (value.diagnosis.text !== undefined) need(typeof value.diagnosis.text === 'string' && value.diagnosis.text.length <= 2000, 'its diagnosis text is not text of at most 2,000 characters');
        }
      }
      if (value.body !== undefined) label(value.body, 'body');
      break;
    case 'train.render': {
      conversation(key, 'its key');
      blob(value.blob, RENDERS);
      // Every render has its size, a video's too: its writer knows it.
      for (const side of ['w', 'h']) need(isInt(value[side]) && value[side] > 0, `its ${side} is not an integer above 0`);
      if (value.step !== undefined) need(isInt(value.step) && value.step >= 0, 'its step is not an integer of at least 0');
      checkpoint(value.checkpoint, false);
      if (value.body !== undefined) label(value.body, 'body');
      break;
    }
    case 'train.checkpoints':
      need(KEY(key), 'its key is not plain text of at most 64 characters');
      conversation(value.thread, 'its thread');
      need(isInt(value.step) && value.step >= 0, 'its step is not an integer of at least 0');
      place(value.place);
      if (value.bytes !== undefined) need(isInt(value.bytes) && value.bytes >= 0, 'its bytes is not an integer of at least 0');
      if (value.metric !== undefined) metric(value.metric);
      passes(value);
      if (value.body !== undefined) label(value.body, 'body');
      if (value.placer !== undefined) need(PLACERS.has(value.placer), `its placer ${JSON.stringify(value.placer)} is not one of jev, config`);
      placedBy(value);
      break;
    case 'train.sweeps':
      need(KEY(key), 'its key is not plain text of at most 64 characters');
      checkpoint(value.checkpoint, true);
      need(isInt(value.rollouts) && value.rollouts > 0, 'its rollouts is not an integer above 0');
      need(finite(value.score), 'its score is not a finite number');
      unit(value.unit, 'its score', measured);
      place(value.place);
      if (value.placer !== undefined) need(PLACERS.has(value.placer), `its placer ${JSON.stringify(value.placer)} is not one of jev, config`);
      placedBy(value);
      if (value.passes_share !== undefined) need(finite(value.passes_share) && value.passes_share >= 0 && value.passes_share <= 1, 'its passes_share is not a number from 0 to 1');
      for (const bound of ['min', 'max']) if (value[bound] !== undefined) need(finite(value[bound]), `its ${bound} is not a finite number`);
      if (finite(value.min) && finite(value.max)) need(value.min <= value.max, `its min ${value.min} is above its max ${value.max}`);
      if (value.course !== undefined) label(value.course, 'course');
      break;
    case 'body.design':
      need(BODY_ID.test(String(key ?? '')), 'its key is not a body id, b- and 8 hex digits');
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
      if (value.target !== undefined) {
        if (!isObject(value.target)) out.push('its target is not { y, label }');
        else { need(finite(value.target.y), 'its target y is not a finite number'); label(value.target.label, 'target label', 40); }
      }
      if (value.marks !== undefined) {
        if (!Array.isArray(value.marks)) out.push('its marks are not a list of { x, label }');
        else value.marks.forEach((mark, at) => { if (!isObject(mark) || !finite(mark.x) || !text(mark.label, 40)) out.push(`its mark ${at} is not { x (a finite number), label (plain text of at most 40 characters) }`); });
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
    case 'body.run':
      need(BODY_ID.test(String(key ?? '')), 'its key is not a body id, b- and 8 hex digits');
      need(RUN_KINDS.has(value.kind), `its kind ${JSON.stringify(value.kind)} is not one of ${[...RUN_KINDS].join(', ')}`);
      label(value.outcome, 'outcome');
      need(nonNegative(value.seconds), 'its seconds is not a number of seconds of at least 0');
      need(typeof value.fits === 'boolean', 'its fits is not true or false');
      for (const count of ['pieces', 'motors']) if (value[count] !== undefined) need(isInt(value[count]) && value[count] >= 0, `its ${count} is not an integer of at least 0`);
      for (const size of ['mass', 'height']) if (value[size] !== undefined) need(nonNegative(value[size]), `its ${size} is not a number of at least 0`);
      // MuJoCo's own error line, kept as text and never parsed.
      if (value.error !== undefined) need(typeof value.error === 'string' && value.error.length <= 2000, 'its error is not text of at most 2,000 characters');
      place(value.place);
      if (value.placer !== undefined) need(PLACERS.has(value.placer), `its placer ${JSON.stringify(value.placer)} is not one of jev, config`);
      placedBy(value);
      break;
    case 'placement': {
      need(KEY(key), 'its key is not plain text of at most 64 characters');
      label(value.work, 'work');
      const env = (v) => text(v, 64);
      need(env(value.current), 'its current is not an environment (plain text of at most 64 characters)');
      need(env(value.chosen), 'its chosen is not an environment (plain text of at most 64 characters)');
      need(PLACERS.has(value.placer), `its placer ${JSON.stringify(value.placer)} is not one of jev, config`);
      if (value.phase !== undefined) need(PHASES.has(value.phase), `its phase ${JSON.stringify(value.phase)} is not one of message, turn_end`);
      const known_rule = value.rule === NEED_THRESHOLD;
      if (value.rule !== undefined) need(text(value.rule, 64), 'its rule is not a rule name (plain text of at most 64 characters)');
      if (value.placer === 'config' || known_rule) need(env(value.rest), `its rest is required ${value.placer === 'config' ? 'for a config placement' : `under ${NEED_THRESHOLD}`}`);
      else if (value.rest !== undefined) need(env(value.rest), 'its rest is not an environment (plain text of at most 64 characters)');
      // A Jev runner's request hash belongs to a Jev-runner placement only: the transport classifier has none.
      if (value.request !== undefined) {
        need(SHA256.test(value.request ?? ''), 'its request is not the Jev request\'s SHA-256');
        need(!known_rule, `its request is set, but a ${NEED_THRESHOLD} placement has no request hash`);
      }
      if (value.classifier !== undefined) need(isObject(value.classifier) && text(value.classifier.provider, 64) && text(value.classifier.model, 128), 'its classifier is not { provider, model }');
      if (value.at !== undefined) need(text(value.at, 64), 'its at is not a time (plain text of at most 64 characters)');
      if (value.error !== undefined) need(typeof value.error === 'string' && value.error.length <= 2000, 'its error is not text of at most 2,000 characters');
      if (value.ref !== undefined) {
        const ref = value.ref;
        const held = typeof ref === 'string' ? known.calls.has(ref)
          : isObject(ref) && typeof ref.callId === 'string' ? known.calls.has(ref.callId)
          : isObject(ref) && typeof ref.doc === 'string' && ref.key !== undefined ? known.documents.has(`${ref.doc}\u0000${ref.key}`) : undefined;
        if (held === undefined) out.push('its ref is not { doc, key } or a call id');
        else need(held, `its ref ${JSON.stringify(ref)} names nothing in this recording`);
      }
      const needs = value.need;
      if (needs !== undefined) {
        if (!isObject(needs)) out.push('its need is not { p, threshold }');
        else {
          if (needs.p !== undefined) need(probability(needs.p), 'its need p is not a number from 0 to 1');
          need(probability(needs.threshold), 'its need threshold is not a number from 0 to 1');
        }
      }
      const where = value.where;
      if (where !== undefined) {
        if (!isObject(where) || !Array.isArray(where.options) || where.options.length === 0) out.push('its where is not { choice, options: [{ environment, purpose?, p }], confidence? }');
        else {
          const options = new Set();
          where.options.forEach((option, at) => {
            if (!isObject(option) || !env(option.environment)) { out.push(`its option ${at} has no environment`); return; }
            options.add(option.environment);
            if (option.purpose !== undefined) need(typeof option.purpose === 'string' && option.purpose.length <= 2000, `its option ${at}'s purpose is not text`);
            if (option.p !== undefined) need(probability(option.p), `its option ${at}'s p is not a number from 0 to 1`);
          });
          const ps = where.options.map((option) => option?.p);
          if (ps.every((each) => finite(each))) {
            const sum = ps.reduce((a, b) => a + b, 0);
            need(Math.abs(sum - 1) <= SUM_SLACK, `its options' p sum to ${Number(sum.toFixed(4))}, not 1 within ${SUM_SLACK}`);
          }
          if (where.confidence !== undefined) need(probability(where.confidence), 'its where confidence is not a number from 0 to 1');
          if (where.choice !== undefined) need(options.has(where.choice), `its where choice ${JSON.stringify(where.choice)} is not one of its options`);
          if (env(value.chosen)) need(options.has(value.chosen) || value.chosen === value.current || value.chosen === value.rest, `its chosen ${JSON.stringify(value.chosen)} is none of its options, its current or its rest`);
        }
      }
      // What the record's rule gives from its own inputs, an error first; never the most likely option. An unknown rule is
      // left unchecked.
      const p = isObject(needs) && probability(needs.p) ? needs.p : undefined;
      const threshold = isObject(needs) && probability(needs.threshold) ? needs.threshold : undefined;
      const choice = isObject(where) && typeof where.choice === 'string' ? where.choice : undefined;
      // Rule first: when the record names a rule, that rule decides, placer config included. A known rule is checked from
      // the record's own inputs, an error or an absent need first; an unknown one is left unchecked. Only with no rule named
      // does config mean chosen == rest, and a plain Jev placement take its one choice (or stay, with an error).
      const answered = value.error === undefined;
      let expected;
      let by;
      if (known_rule) {
        by = NEED_THRESHOLD;
        if (!answered || needs === undefined) expected = value.current;
        else if (p !== undefined && threshold !== undefined && p >= threshold && choice !== undefined && choice !== value.current) expected = choice;
        else if (value.phase === 'turn_end' && p !== undefined && threshold !== undefined && p < threshold && value.current !== value.rest) expected = value.rest;
        else expected = value.current;
      } else if (value.rule === undefined && value.placer === 'config') { by = 'a config placement'; expected = value.rest; }
      else if (value.rule === undefined && value.placer === 'jev') { by = 'its one choice question'; expected = answered ? choice : value.current; }
      if (by !== undefined && (expected !== undefined || by === 'its one choice question')) {
        need(value.chosen === expected, `its chosen ${JSON.stringify(value.chosen)} is not what ${by} gives, ${JSON.stringify(expected ?? null)}`);
      }
      break;
    }
    case 'body.render': {
      need(BODY_ID.test(String(key ?? '')), 'its key is not a body id, b- and 8 hex digits');
      const ext = blob(value.blob, BODY_RENDERS);
      if (ext !== undefined) { const bytes = known.sizeOf(value.blob); need(bytes <= BODY_RENDER_BYTES, `its blob is ${bytes} bytes, over the ${BODY_RENDER_BYTES} a body render may be`); }
      for (const side of ['w', 'h']) need(isInt(value[side]) && value[side] > 0, `its ${side} is not an integer above 0`);
      break;
    }
  }
  return out;
}
