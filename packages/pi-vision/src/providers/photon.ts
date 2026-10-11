// The default image processor: Photon (WASM, the processor pi uses), in a worker thread, when the host has installed
// `@silvia-odwyer/photon-node`. The worker holds the decoded pixels in WebAssembly memory, four bytes a pixel, which
// does not shrink again: it is stopped after a second idle, after an error (Photon traps on input it cannot decode, and
// its instance is not reused after that) and after `timeoutMs`, so a hostile image costs one worker for a bounded time.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { imageProcessor, type ImageProcessor, type Raster } from "../core/image.js";
import { imageHeader } from "../core/kinds.js";
import type { Provider } from "../core/provider.js";

const PHOTON = "@silvia-odwyer/photon-node";
/** One operation is cut after this long. */
const TIMEOUT_MS = 60_000;
/** The worker, and the memory its decodes grew, are released this long after the last operation. */
const IDLE_MS = 1000;

/** The worker's program. A string, so it runs wherever the package is bundled, and written to run as a CommonJS script
 *  or as a module, whichever the process's flags make an `eval` worker; it speaks one request at a time. A
 *  quarter turn swaps what is resized first, so the turn runs on the small raster. `turn` maps each pixel of an image
 *  stored with an EXIF orientation to its place upright: x' = ax*x + bx*y + cx, y' = ay*x + by*y + cy. */
const WORKER = `
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const photon = process.getBuiltinModule("node:module").createRequire(workerData.photon)(workerData.photon);
const turn = (pixels, w, h, o) => {
  if (o < 2) return { data: pixels, width: w, height: h };
  const [ax, bx, cx, ay, by, cy] = [[1, 0, 0, 0, 1, 0], [-1, 0, w - 1, 0, 1, 0], [-1, 0, w - 1, 0, -1, h - 1], [1, 0, 0, 0, -1, h - 1], [0, 1, 0, 1, 0, 0], [0, -1, h - 1, 1, 0, 0], [0, -1, h - 1, -1, 0, w - 1], [0, 1, 0, -1, 0, w - 1]][o - 1];
  const source = new Uint32Array(pixels.buffer, pixels.byteOffset, w * h);
  const out = new Uint32Array(w * h);
  const width = o >= 5 ? h : w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(ay * x + by * y + cy) * width + (ax * x + bx * y + cx)] = source[y * w + x];
  return { data: new Uint8Array(out.buffer), width, height: o >= 5 ? w : h };
};
const operations = {
  raster({ bytes, size, orientation }) {
    let image = photon.PhotonImage.new_from_byteslice(bytes);
    try {
      const [width, height] = size ? (orientation >= 5 ? [size.height, size.width] : [size.width, size.height]) : [image.get_width(), image.get_height()];
      if (width !== image.get_width() || height !== image.get_height()) { const small = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3); image.free(); image = small; }
      const out = turn(image.get_raw_pixels(), width, height, orientation);
      return { value: { ...out, channels: 4 }, transfer: [out.data.buffer] };
    } finally { image.free(); }
  },
  encode({ raster, quality }) {
    const px = raster.data;
    if (quality !== undefined) for (let i = 3; i < px.length; i += 4) { const a = px[i]; if (a < 255) { for (let c = 1; c <= 3; c++) px[i - c] = Math.round((px[i - c] * a + 255 * (255 - a)) / 255); px[i] = 255; } }
    const image = new photon.PhotonImage(px, raster.width, raster.height);
    try { const data = quality === undefined ? image.get_bytes() : image.get_bytes_jpeg(quality); return { value: data, transfer: [data.buffer] }; } finally { image.free(); }
  },
};
parentPort.on("message", ({ op, args }) => {
  try { const { value, transfer } = operations[op](args); parentPort.postMessage({ value }, transfer); }
  catch (error) { parentPort.postMessage({ error: String((error && error.message) || error) }); }
});`;

export type PhotonOptions = { /** Cut one operation after this many milliseconds. */ readonly timeoutMs?: number };

export function photonImages(options: PhotonOptions = {}): ImageProcessor & Provider {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  /** The path of Photon's entry, found from this package and then from the working directory; throws a `needs` error. */
  const locate = (): string => {
    for (const from of [import.meta.url, join(process.cwd(), "noop.js")]) {
      try { return createRequire(from).resolve(PHOTON); } catch { /* try the next place */ }
    }
    throw Object.assign(new Error(`Photon (${PHOTON}) is not installed`), { code: "needs" });
  };
  let worker: Worker | undefined;
  let current: { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void } | undefined;
  let idle: NodeJS.Timeout | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const stop = (reason: Error) => {
    clearTimeout(idle);
    const [stopped, waiting] = [worker, current];
    worker = current = undefined;
    void stopped?.terminate();
    waiting?.reject(reason);
  };
  const spawn = (): Worker => {
    const next = new Worker(WORKER, { eval: true, workerData: { photon: locate() } });
    next.on("message", (reply: { value?: unknown; error?: string }) => {
      const waiting = current;
      current = undefined;
      if (reply.error !== undefined) { waiting?.reject(new Error(reply.error === "unreachable" ? "Photon's decoder trapped on it" : reply.error)); stop(new Error("Photon's worker was retired after an error")); return; }
      waiting?.resolve(reply.value);
      next.unref();
      idle = setTimeout(() => stop(new Error("Photon's worker was retired when idle")), IDLE_MS);
      idle.unref();
    });
    next.on("error", (error) => stop(error));
    next.on("exit", () => { if (worker === next) stop(new Error("Photon's worker exited")); });
    return next;
  };
  const call = (op: "raster" | "encode", args: unknown): Promise<any> => {
    const result = tail.then(() => new Promise((resolve, reject) => {
      clearTimeout(idle);
      const active = (worker ??= spawn());
      const timer = setTimeout(() => stop(new Error(`Photon took longer than ${timeoutMs} ms`)), timeoutMs);
      current = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      active.ref();
      active.postMessage({ op, args });
    }));
    tail = result.catch(() => undefined);
    return result;
  };

  return {
    name: "photon",
    capabilities: ["fit"],
    kinds: ["image"],
    async detect() {
      try {
        return { available: true, version: String(JSON.parse(readFileSync(join(dirname(locate()), "package.json"), "utf8")).version) };
      } catch (error) {
        return { available: false, needs: PHOTON, reason: String((error as Error).message).split("\n")[0]! };
      }
    },
    ...imageProcessor({
      // TIFF is read only when it is stored without JPEG or WebP compression: Photon traps on those (measured 2026-10-11, 0.3.4).
      decodes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff"],
      async raster(bytes: Uint8Array, { size, maxPixels }): Promise<Raster> {
        const header = imageHeader(bytes);
        if (!header || header.width * header.height > maxPixels) throw new Error("its size is not in its header, or is over what Photon is asked to decode");
        return call("raster", { bytes, size, orientation: header.orientation });
      },
      encode: (raster, quality) => call("encode", { raster, quality }),
    }),
  };
}
