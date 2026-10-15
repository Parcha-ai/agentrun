// The archive read as one workflow: three fan-outs side by side (the film in windows, the transcript page by page, the photos one
// by one), each item a short agent that asks the eyes one question through `read` and hands back the receipt (and, for a window or
// a photo, what the eyes said); then the landing's lines, taken from the pages' receipts by a tool, in mission-time order; the
// account written from them, every sentence citing the receipts it rests on; and the cited result, each cite resolved by a tool to
// the look that backs it.
import type { Workflow } from '@parcha/agentrun-dsl';

/** What the eyes are asked of each kind of item. The page's answer is JSON lines, so the times it read are parsed, never searched for. */
export const ASKS = {
  film: 'These frames are from NASA film of the Apollo 11 mission, in time order. In two or three sentences: what do they show, and what changes across them (the view, a spacecraft, the lunar surface, people, any text on screen)?',
  page: 'This is a page of NASA\'s 1969 typewritten Apollo 11 air-to-ground transcript. Transcribe every line on it, in order, as JSON lines and nothing else: one object per line, {"time": the mission time exactly as typed (four two-digit groups, "DD HH MM SS"), "speaker": the call sign (CDR, LMP, CMP, CC, ...), "text": the words}. A line with no time of its own has "time": "". Copy every digit as printed; a digit you cannot read is "?".',
  photo: (classes: Record<string, string>) => `Which one of these classes fits this NASA photograph of the Apollo 11 mission best?\n${Object.entries(classes).map(([name, meaning]) => `- ${name}: ${meaning}`).join('\n')}\nAnswer with the class name alone on the first line, then one sentence on what the photograph shows.`,
};

const Receipt = { type: 'string', minLength: 1, description: 'The receipt the read named, exactly as its result gives it (evidence/...json).' } as const;

/** The input, a flat form: the ranges a run reads and the files they are in. Each map item's state carries the whole state before
 *  the map, so the lists are built from the ranges by a code step and hold ids and numbers only; the asks are in the instructions. */
export const INPUT = {
  type: 'object', additionalProperties: false,
  required: ['film_item', 'film_file', 'film_from_s', 'film_to_s', 'window_s', 'scan_item', 'scan_file', 'pages_from', 'pages_to', 'photos', 'photo_ext', 'typed_item', 'typed_file', 'span_from', 'span_to'],
  properties: {
    film_item: { type: 'string', description: 'The film\'s id in sources.json.' },
    film_file: { type: 'string', description: 'The film\'s file in the workspace.' },
    film_from_s: { type: 'number', description: 'The film second the first window starts at.' },
    film_to_s: { type: 'number', description: 'The film second the last window ends at; equal to film_from_s reads no film.' },
    window_s: { type: 'number', exclusiveMinimum: 0, description: 'Seconds of film in one window.' },
    scan_item: { type: 'string', description: 'The scanned transcript\'s id in sources.json.' },
    scan_file: { type: 'string', description: 'The scanned transcript\'s file in the workspace.' },
    pages_from: { type: 'integer', minimum: 1, description: 'The first page of the scan to read.' },
    pages_to: { type: 'integer', minimum: 0, description: 'The last page of the scan to read; below pages_from reads none.' },
    photos: { type: 'array', items: { type: 'string' }, description: 'The photographs to sort, by their ids in sources.json.' },
    photo_ext: { type: 'string', description: 'The photographs\' file extension in the workspace (each file is <id><photo_ext>).' },
    typed_item: { type: 'string', description: 'NASA\'s typed transcript (or the slice\'s cut of it), the times read are checked against: its id.' },
    typed_file: { type: 'string', description: 'The typed transcript\'s file in the workspace.' },
    span_from: { type: 'string', pattern: '^\\d\\d \\d\\d \\d\\d \\d\\d$', description: 'The first mission time the account covers, as the transcript types it (DD HH MM SS).' },
    span_to: { type: 'string', pattern: '^\\d\\d \\d\\d \\d\\d \\d\\d$', description: 'The last mission time the account covers, as the transcript types it.' },
  },
} as const;

export function workflowOf(classes: Record<string, string>) {
  return {
    v: 2,
    name: 'apollo11-read-whole',
    schemas: {
      Input: INPUT,
      Window: {
        type: 'object', additionalProperties: false, required: ['item', 'from_s', 'to_s', 'seen', 'receipt'],
        properties: { item: { type: 'string' }, from_s: { type: 'number' }, to_s: { type: 'number' }, seen: { type: 'string', description: 'What the eyes said the frames show.' }, receipt: Receipt },
      },
      Page: {
        type: 'object', additionalProperties: false, required: ['item', 'page', 'receipt'],
        properties: { item: { type: 'string' }, page: { type: 'integer' }, receipt: Receipt },
      },
      Landing: {
        type: 'object', required: ['lines', 'windows'],
        properties: {
          lines: { type: 'array', items: { type: 'object', required: ['time', 'mission_time', 'speaker', 'text', 'item', 'page', 'receipt'] } },
          windows: { type: 'array', items: { type: 'object' } },
        },
      },
      Photo: {
        type: 'object', additionalProperties: false, required: ['item', 'class', 'receipt'],
        properties: { item: { type: 'string' }, class: { type: 'string', enum: Object.keys(classes) }, receipt: Receipt },
      },
      Account: {
        type: 'object', additionalProperties: false, required: ['entries'],
        properties: {
          entries: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', additionalProperties: false, required: ['mission_time', 'text', 'cites'],
              properties: {
                mission_time: { type: 'string', pattern: '^\\d{3}:\\d{2}:\\d{2}$', description: 'hhh:mm:ss, hours since launch.' },
                text: { type: 'string', minLength: 1 },
                cites: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['item', 'receipt'], properties: { item: { type: 'string' }, receipt: Receipt } } },
              },
            },
          },
        },
      },
      Cited: {
        type: 'object', required: ['format', 'rows'],
        properties: { format: { type: 'string', const: 'agentrun.cited/1' }, title: { type: 'string' }, rows: { type: 'array' }, apollo11: { type: 'object' } },
      },
    },
    input: { schemaId: 'Input' },
    output: { schemaId: 'Cited', path: 'result' },
    root: { node: 'chain', steps: [
      {
        node: 'code', label: 'plan',
        code: '(s) => { const windows = []; for (let at = s.film_from_s; at < s.film_to_s; at += s.window_s) windows.push({ from_s: at, to_s: Math.min(s.film_to_s, at + s.window_s) }); const pages = []; for (let page = s.pages_from; page <= s.pages_to; page += 1) pages.push(page); return { windows, pages }; }',
      },
      { node: 'parallel', label: 'read', branches: [
        { node: 'map', label: 'film', itemsPath: 'windows', as: 'film', resultPath: 'window', maxConcurrency: 4, body: {
          node: 'agent', label: 'window', out: 'Window', as: 'window', tools: ['read'], thinking: 'low',
          state: { item: '{film_item}', path: '{film_file}', from_s: '{item.from_s}', to_s: '{item.to_s}' },
          instructions: `Call read once with path, from_s and to_s exactly as the state gives them, and ask set to exactly this text: ${ASKS.film}\nThen submit item, from_s and to_s as given; seen: what the answer says the frames show, in its own words and no more; receipt: the evidence path the result names.`,
        } },
        { node: 'map', label: 'transcript', itemsPath: 'pages', as: 'transcript', resultPath: 'page', maxConcurrency: 6, body: {
          node: 'agent', label: 'page', out: 'Page', as: 'page', tools: ['read'], thinking: 'low',
          state: { item: '{scan_item}', path: '{scan_file}', page: '{item}' },
          instructions: `Call read once with path and page exactly as the state gives them, and ask set to exactly this text: ${ASKS.page}\nThen submit item and page as given, and receipt: the evidence path the result names, whether the eyes saw the page or not. Copy nothing of the page itself: its lines are taken from that receipt.`,
        } },
        { node: 'map', label: 'photos', itemsPath: 'photos', as: 'sorted', resultPath: 'photo', maxConcurrency: 4, body: {
          node: 'agent', label: 'photo', out: 'Photo', as: 'photo', tools: ['read'], thinking: 'low',
          state: { item: '{item}', path: '{item}{photo_ext}' },
          instructions: `Call read once with path exactly as the state gives it, and ask set to exactly this text: ${ASKS.photo(classes)}\nSubmit item as given; class: the class the answer names on its first line; receipt: the evidence path the result names.`,
        } },
      ] },
      // A tool reads the pages' receipts (the eyes' JSON lines) and returns the lines inside the span, in mission-time order.
      { node: 'call', label: 'landing', via: 'tool', tool: 'landing', args: { pages: '{transcript}', windows: '{film}', span_from: '{span_from}', span_to: '{span_to}' }, out: 'Landing', as: 'landing', deadline_s: 60 },
      {
        node: 'extract', label: 'account', out: 'Account', as: 'account', tools: [], thinking: 'low',
        state: { lines: '{landing.lines}', windows: '{landing.windows}' },
        instructions: 'Write the Apollo 11 landing minute by minute from what was read. `lines` are the transcript\'s lines in mission-time order (mission_time is hhh:mm:ss since launch), each with the receipt of the page it was read from; `windows` are film windows with what the eyes saw and their receipts. For each minute that has lines, write one entry: mission_time, copied from the first line the entry rests on; text, one or two plain sentences of what happened in that minute, quoting call-outs exactly as transcribed; cites, each { item, receipt } the sentence rests on, copied from the input: the pages of its lines, and a film window only where its frames show what the sentence says. The film\'s seconds are not mission time: every entry rests on lines, and its time is a line\'s. Write nothing the lines and windows do not show.',
      },
      // A tool resolves every cite to the look that backs it and builds the cited result.
      { node: 'call', label: 'cite', via: 'tool', tool: 'cite', args: { entries: '{account.entries}', windows: '{film}', pages: '{transcript}', photos: '{sorted}', typed: '{typed_file}' }, out: 'Cited', as: 'result', deadline_s: 60 },
    ] },
  } as const satisfies Workflow;
}
