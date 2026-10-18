// The fast image processor: the host's own `sharp` module, passed in. The package never resolves sharp itself, so its
// native libraries come with the host's install and stay out of this package's dependency graph.
import { imageProcessor, type ImageProcessor } from "../core/image.js";
import type { Provider } from "../core/provider.js";

/** The parts of sharp's default export this processor calls, left loose so any sharp 0.34 or later is one. */
export type SharpModule = ((input?: any, options?: any) => any) & {
  readonly versions?: { readonly sharp?: string };
  readonly format?: Readonly<Record<string, { readonly input?: { readonly buffer?: boolean } } | undefined>>;
};

/** The MIME types sharp reads, by the id of the format it reads them with. HEIC is not among them: its prebuilt libheif
 *  has no HEVC decoder (measured 2026-10-11, sharp 0.35.5), and BMP has no loader in libvips. */
const FORMAT_IDS: Readonly<Record<string, string>> = Object.freeze({ "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp", "image/tiff": "tiff", "image/avif": "heif" });

/** The operations that turn an image stored with each EXIF orientation upright. Sharp does a flip or flop before any
 *  rotation, whatever order they are called in, so a transpose is a flop then a quarter turn. */
const TURNS: Readonly<Record<number, { readonly flip?: true; readonly flop?: true; readonly rotate?: number }>> = Object.freeze({
  2: { flop: true }, 3: { rotate: 180 }, 4: { flip: true }, 5: { flop: true, rotate: 270 }, 6: { rotate: 90 }, 7: { flop: true, rotate: 90 }, 8: { rotate: 270 },
});

/** The fast image processor, on the host's own `sharp` module. The package never resolves sharp itself, so its native libraries stay
 *  with the host's install. */
export function sharpImages(sharp: SharpModule): ImageProcessor & Provider {
  if (typeof sharp !== "function") throw new TypeError("sharpImages takes sharp's default export: import sharp from \"sharp\"");
  const open = (bytes: Uint8Array, maxPixels?: number) => sharp(bytes, { limitInputPixels: maxPixels ?? false, failOn: "error" });
  return {
    name: "sharp",
    capabilities: ["fit"],
    kinds: ["image"],
    async detect() {
      return { available: true, version: String(sharp.versions?.sharp ?? "unknown") };
    },
    ...imageProcessor({
      decodes: Object.entries(FORMAT_IDS).filter(([, id]) => sharp.format?.[id]?.input?.buffer !== false).map(([mimeType]) => mimeType),
      async probe(bytes: Uint8Array) {
        const meta = await open(bytes).metadata();
        return meta.width && meta.height ? { width: meta.width, height: meta.height, orientation: meta.orientation ?? 1 } : undefined;
      },
      async raster(bytes, { size, orientation, maxPixels }) {
        const turn = TURNS[orientation];
        let image = open(bytes, maxPixels);
        if (turn?.flop) image = image.flop();
        if (turn?.flip) image = image.flip();
        if (turn?.rotate) image = image.rotate(turn.rotate);
        if (size) image = image.resize({ width: size.width, height: size.height, fit: "fill" });
        const { data, info } = await image.toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, channels: info.channels, data };
      },
      async encode(raster, jpegQuality) {
        const image = sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: raster.channels } });
        return jpegQuality === undefined ? image.png().toBuffer() : image.flatten({ background: "#ffffff" }).jpeg({ quality: jpegQuality }).toBuffer();
      },
    }),
  };
}
