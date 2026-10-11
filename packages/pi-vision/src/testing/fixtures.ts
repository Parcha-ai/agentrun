// Fixtures a test builds for itself: a directory of its own under the temp root, and images written with nothing but
// Node. The image size reader here is independent of the package's own header parsing, so a test can check the
// package with it.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

export type FixtureDir = {
  readonly path: string;
  /** Write `name` (a relative path, directories made as needed) and give its absolute path. */
  file(name: string, content: string | Uint8Array): Promise<string>;
  remove(): Promise<void>;
};

/** A new directory under the temp root (`TMPDIR` when set). */
export async function fixtureDir(prefix = "pi-vision-"): Promise<FixtureDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async file(name, content) {
      const target = join(path, name);
      if (!target.startsWith(`${path}/`)) throw new RangeError(`fixture name leaves the directory: ${name}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return target;
    },
    remove: () => rm(path, { recursive: true, force: true }),
  };
}

type Rgb = readonly [number, number, number];

const chunk = (type: string, data: Uint8Array): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** An 8-bit RGB PNG of `width` x `height`, filled with one colour or with `fill(x, y)`. */
export function pngBytes(width: number, height: number, fill: Rgb | ((x: number, y: number) => Rgb) = [255, 255, 255]): Uint8Array {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new RangeError(`not a size: ${width}x${height}`);
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = typeof fill === "function" ? fill(x, y) : fill;
      raw.writeUInt8(r, y * row + 1 + x * 3);
      raw.writeUInt8(g, y * row + 2 + x * 3);
      raw.writeUInt8(b, y * row + 3 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]));
}

/** The pixels of a PNG, JPEG or GIF from its header; null for anything else or a truncated header. */
export function imageSize(bytes: Uint8Array): { mimeType: string; width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR") return { mimeType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("latin1", 0, 4) === "GIF8") return { mimeType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let at = 2; at + 9 < b.length; ) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      // A start-of-frame segment (C0 to CF, except the DHT, JPG and DAC markers) holds the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mimeType: "image/jpeg", width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
      at += 2 + b.readUInt16BE(at + 2);
    }
  }
  return null;
}
