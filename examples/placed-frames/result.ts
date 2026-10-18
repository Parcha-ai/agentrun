// The result as the recording keeps it: every frame of the zoom on one sheet, a PNG drawn from the frames the run kept on its disk, and a cited record with one row for the
// sheet and one for each environment. Every row cites what it rests on: the sheet row cites the sheet and each frame's own picture; an environment's row cites each tool call that was
// placed there (the call kept as a blob: the tool, its arguments and its answer) and the release call that names its box.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { DemoOptions } from '@parcha/agentrun-reference';
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

export const result: NonNullable<DemoOptions['result']> = (_record, { dir, keep }) => {
  // Everything the card says is read from the calls the tools answered and the frames the run kept, never from what the agent wrote.
  const calls = callsOf(dir);
  const frameCalls = calls.filter((call) => call.tool === 'frame');
  const release = calls.find((call) => call.tool === 'release');
  const count = frameCalls.length;
  // Each frame as the run kept it; a missing frame fails the result.
  const frames = frameCalls.map((call) => readFileSync(join(dir, 'work', 'frames', `f${call.answer.f}.idx`)));
  const blob = keep(sheet(frames), 'png');
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
