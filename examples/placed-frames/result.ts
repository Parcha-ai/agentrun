// The result as the recording keeps it: every frame of the zoom on one sheet, a PNG drawn from the frames the run kept on its disk, and a cited record with one row for the
// sheet and one for each environment: its frames and its box.
import { readFileSync } from 'node:fs';
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
type Made = { frames: number; placed: Record<string, number[]>; boxes: Box[] };

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

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const made = record as Made;
  // Each frame as the run kept it (the test checks each against the hash its answer names); a missing frame fails the result.
  const frames = Array.from({ length: made.frames }, (_, f) => readFileSync(join(dir, 'work', 'frames', `f${f}.idx`)));
  const blob = keep(sheet(frames), 'png');
  const title = `A zoom of ${made.frames} frames, each a tool call placed in a sandbox`;
  const rows = [
    { label: 'the zoom', value: `${made.frames} frames, in order, ${COLUMNS} to a row`, note: 'drawn from the frames the run kept', cites: [{ blob, note: 'every frame of the zoom' }] },
    ...Object.entries(made.placed).map(([environment, list]) => {
      const box = made.boxes.find((each) => each.environment === environment);
      return { label: environment, value: `frames ${list.join(', ')}`, note: box ? `in ${box.box} (${box.provider})` : 'its box is not in the release', cites: [] };
    }),
  ];
  return { json: { format: 'agentrun.cited/1', title, rows }, title };
};
