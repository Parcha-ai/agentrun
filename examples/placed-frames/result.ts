// The result as the recording keeps it: every frame of the zoom on one sheet, a PNG drawn from the frames the run kept on its disk, and a cited record with one row for the
// sheet and one for each environment, and the report the host keeps with the recording (`work/report/index.html`, draft 41): the zoom as a grid of its frames, each captioned with its box, its environment and Jev's score and citing its frame call.
// This hook writes the page, not the agent: the agent has no file or command tool by design, so it cannot, and a tool that read or wrote files for it could reach the host's environment. Every row cites what it rests on: the sheet row cites the sheet and each frame's own picture; an environment's row cites each tool call that was
// placed there (the call kept as a blob: the tool, its arguments and its answer) and the release call that names its box.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { DemoOptions } from '@parcha/agentrun-harness';
import { rgbOf } from './programs/palette.mjs';
import { HEIGHT, WIDTH } from './programs/params.mjs';

/** Frames a row of the sheet. */
const COLUMNS = 4;
const GAP = 4;

const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
};

/** A PNG of `rgb` (width by height, three bytes a pixel). */
export function png(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(rows, y * (width * 3 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

type Box = { box: string; environment: string; provider: string };
type Call = { tool: string; args: Record<string, unknown>; answer: { f?: number; environment?: string; box?: string; boxes?: Box[]; iterations?: number } };

/** The agent's tool calls as the run's disk holds them (`work/frames/*.call.json`, one for each call the tools answered): the tool, its arguments and its answer. */
function callsOf(dir: string): Call[] {
  const frames = join(dir, 'work', 'frames');
  return readdirSync(frames).filter((name) => name.endsWith('.call.json')).map((name) => JSON.parse(readFileSync(join(frames, name), 'utf8')) as Call)
    .sort((a, b) => (a.answer.f ?? Infinity) - (b.answer.f ?? Infinity));
}

/** One frame's own picture (its palette indices drawn in colour). */
export function framePicture(pixels: Buffer): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < pixels.length; i += 1) rgb.set(rgbOf(pixels[i]!), i * 3);
  return png(WIDTH, HEIGHT, rgb);
}

/** The sheet: frame f at column f % COLUMNS, row f / COLUMNS, in the order of the zoom. */
export function sheet(frames: Buffer[]): Uint8Array {
  const rows = Math.ceil(frames.length / COLUMNS);
  const width = COLUMNS * WIDTH + (COLUMNS - 1) * GAP;
  const height = rows * HEIGHT + (rows - 1) * GAP;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  frames.forEach((pixels, f) => {
    const left = (f % COLUMNS) * (WIDTH + GAP);
    const top = Math.floor(f / COLUMNS) * (HEIGHT + GAP);
    for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) rgb.set(rgbOf(pixels[y * WIDTH + x]!), ((top + y) * width + left + x) * 3);
  });
  return png(width, height, rgb);
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = (f: number) => String(f + 1).padStart(2, '0');

/** One frame's caption: where it ran (the box by its label, and its environment) and the score the placer gave the need, from the placement record the answer carries. */
function caption(call: Call): { title: string; score: string } {
  const answer = call.answer as { box?: string; environment?: string; placed?: { by?: string; need?: number | null } };
  const who = answer.placed?.by === 'jev' ? 'Jev' : 'the script';
  const need = answer.placed?.need;
  return { title: `${answer.box ?? 'box'} \u00b7 ${answer.environment ?? 'sandbox'}`, score: need === null || need === undefined ? `${who} gave no score` : `${who}'s need score ${need.toFixed(2)}` };
}

/** The report page: the zoom's frames in order, four to a row, each a picture with its caption and a link to the call that drew it, and the sheet of all of them below. No script, no outside address. */
export function reportPage(frameCalls: Call[]): string {
  const figures = frameCalls.map((call) => {
    const f = call.answer.f!;
    const { title, score } = caption(call);
    return `    <figure>
      <img src="frames/frame-${pad(f)}.png" alt="Frame ${f + 1} of the zoom, drawn in ${escapeHtml(title)}">
      <figcaption><strong>${escapeHtml(title)}</strong><span>frame ${f + 1} \u00b7 ${escapeHtml(score)}</span><a class="cite" href="calls/frame-${pad(f)}.json">the call for frame ${f + 1}</a></figcaption>
    </figure>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A zoom of ${frameCalls.length} frames, each a tool call placed in a sandbox</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #5c5c5c; --line: #d8d8d8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d0d0d; --fg: #ececec; --muted: #a0a0a0; --line: #2c2c2c; } }
  body { margin: 0 auto; max-width: 72rem; padding: 1.5rem 1rem 3rem; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  p { color: var(--muted); margin: .25rem 0 1.25rem; max-width: 46rem; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
  @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  figure { margin: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  img { display: block; width: 100%; height: auto; }
  figcaption { display: grid; gap: .1rem; padding: .5rem .6rem .6rem; font-size: .85rem; }
  figcaption span, figcaption a { color: var(--muted); }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
</style>
</head>
<body>
  <h1>A zoom of ${frameCalls.length} frames, each a tool call placed in a sandbox</h1>
  <p>Each frame is one tool call. Before it ran, the placer read the frame and each sandbox's purpose and picked where it was drawn. The caption names the sandbox and the score the placer gave the need; the link opens the call that drew the frame.</p>
  <div class="grid">
${figures}
  </div>
  <h2>All the frames on one sheet</h2>
  <img src="sheet.png" alt="Every frame of the zoom on one sheet">
</body>
</html>
`;
}

export const result: NonNullable<DemoOptions['result']> = (_record, { dir, keep }) => {
  // Everything the card says is read from the calls the tools answered and the frames the run kept, never from what the agent wrote.
  const calls = callsOf(dir);
  const frameCalls = calls.filter((call) => call.tool === 'frame');
  const release = calls.find((call) => call.tool === 'release');
  const count = frameCalls.length;
  // A run that stopped short is not published as finished: every frame the calls ask for is drawn, and the release answered, naming each sandbox the frames ran in.
  const asked = Math.max(0, ...frameCalls.map((call) => Number(call.args.frames)));
  const missing = [...Array(asked).keys()].filter((f) => !frameCalls.some((call) => call.answer.f === f));
  const problems = [
    ...(count === 0 ? ['no frame was drawn'] : []),
    ...(missing.length > 0 ? [`${missing.length === 1 ? 'frame' : 'frames'} ${missing.map((f) => f + 1).join(', ')} not drawn`] : []),
    ...(release === undefined ? ['the release call was never answered, so its sandboxes may still be running'] : [...new Set(frameCalls.map((call) => call.answer.environment))].filter((environment) => !(release.answer.boxes ?? []).some((box) => box.environment === environment)).map((environment) => `the ${environment} sandbox is not in the release`)),
  ];
  if (problems.length > 0) throw new Error(`the run is incomplete: ${problems.join('; ')}`);
  // Each frame as the run kept it; a missing frame fails the result.
  const frames = frameCalls.map((call) => readFileSync(join(dir, 'work', 'frames', `f${call.answer.f}.idx`)));
  const sheetPng = sheet(frames);
  const blob = keep(sheetPng, 'png');
  // The report the host keeps with the recording: written here, in `work/report/`, which the host reads when the run is done.
  const report = join(dir, 'work', 'report');
  mkdirSync(join(report, 'frames'), { recursive: true });
  mkdirSync(join(report, 'calls'), { recursive: true });
  frames.forEach((pixels, i) => writeFileSync(join(report, 'frames', `frame-${pad(frameCalls[i]!.answer.f!)}.png`), framePicture(pixels)));
  writeFileSync(join(report, 'sheet.png'), sheetPng);
  for (const call of calls) writeFileSync(join(report, 'calls', call.tool === 'release' ? 'release.json' : `frame-${pad(call.answer.f!)}.json`), JSON.stringify({ tool: call.tool, args: call.args, answer: call.answer }));
  writeFileSync(join(report, 'index.html'), reportPage(frameCalls));
  // Each tool call is kept as a blob, and cited by it: the row for an environment cites the calls it counts.
  const callBlob = new Map(calls.map((call) => [call, keep(JSON.stringify({ tool: call.tool, args: call.args, answer: call.answer }), 'json')]));
  const placed = new Map<string, number[]>();
  for (const call of frameCalls) placed.set(call.answer.environment!, [...(placed.get(call.answer.environment!) ?? []), call.answer.f! + 1]);
  const title = `A zoom of ${count} frames, each a tool call placed in a sandbox`;
  const rows = [
    {
      label: 'the zoom', value: `${count} frames, in order, ${COLUMNS} to a row`, note: 'drawn from the frames the run kept',
      cites: [
        { blob, note: 'every frame of the zoom on one sheet' },
        ...frames.map((pixels, i) => ({ blob: keep(framePicture(pixels), 'png'), note: `frame ${i + 1}, drawn in ${frameCalls[i]!.answer.box}` })),
      ],
    },
    ...[...placed].map(([environment, list]) => {
      const box = (release?.answer.boxes ?? []).find((each) => each.environment === environment);
      return {
        label: environment, value: `frames ${list.join(', ')}`, note: box ? `in ${box.box} (${box.provider})` : 'its box is not in the release',
        cites: [
          ...frameCalls.filter((call) => call.answer.environment === environment).map((call) => ({ blob: callBlob.get(call)!, note: `the call for frame ${call.answer.f! + 1}, in ${call.answer.box}` })),
          ...(release ? [{ blob: callBlob.get(release)!, note: 'the release call, which names the box' }] : []),
        ],
      };
    }),
  ];
  return { json: { format: 'agentrun.cited/1', title, rows }, title };
};
