// pdf_pages: a document's first pages as PNG files in the run's work directory, and its text, for a workflow's call node
// `via: "tool"`. The document is a file name under the server's documents directory (`--documents`,
// AGENTRUN_SERVE_DOCUMENTS) or the run's work directory, confined to it. Pages are drawn by poppler's pdftoppm into
// `work/pages/<doc-stem>/<dpi>/<n>.png`, at the asked dpi lowered so a page's long side stays within MAX_PAGE_PX (Jev's
// image limit); the dpi used is in the answer and the path, so a draw at another dpi never replaces an image an earlier
// receipt points to. A PNG or JPEG passes through as its one page, scaled down with ffmpeg when a side is over the cap. The image refs it answers are work-relative, the
// form a decision node's `images` takes.
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const PDF_PAGES_TOOL = "pdf_pages";
/** The read-only directory a run's documents are read from: the server's `--documents`. */
export const DOCUMENTS_ENV = "AGENTRUN_SERVE_DOCUMENTS";
const TEXT_CAP = 20_000;
const MAX_PAGES = 50;
/** The longest side a drawn page may have, in pixels: Jev's image limit (1568 per side; 1569 is refused). */
export const MAX_PAGE_PX = 1568;
const run = promisify(execFile);

/** `dpi`: the dpi the pages were drawn at (at most the asked one); null for an image that passed through. */
export type PdfPages = { name: string; pageCount: number; dpi: number | null; pages: { page: number; image: string }[]; text: string };

const inside = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

/** `path` under `base`, symlinks resolved, or undefined when it is not a file there. */
async function confined(base: string, path: string): Promise<string | undefined> {
  const root = await realpath(base).catch(() => undefined);
  if (!root) return undefined;
  const asked = resolve(root, path);
  if (!inside(root, asked)) return undefined;
  const real = await realpath(asked).catch(() => undefined);
  if (!real || !inside(root, real)) return undefined;
  return (await stat(real)).isFile() ? real : undefined;
}

/** Where a document named `path` is: the documents directory first, then the run's work directory. */
export async function documentPath(path: unknown, where: { work: string; documents?: string | undefined }): Promise<string> {
  if (typeof path !== "string" || !path.trim()) throw new Error("pdf_pages: path is a file name");
  if (isAbsolute(path)) throw new Error(`pdf_pages: path ${path} is absolute; name a file under the documents or the run's work directory`);
  for (const base of [where.documents, where.work]) {
    if (!base) continue;
    const found = await confined(base, path);
    if (found) return found;
  }
  throw new Error(`pdf_pages: no file ${path} under the documents${where.documents ? "" : " (this server has no --documents)"} or the run's work directory`);
}

const integer = (value: unknown, fallback: number, min: number, max: number, name: string) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`pdf_pages: ${name} is an integer from ${min} to ${max}`);
  return value;
};

/** The pages and text of the document `args.path`, drawn into `where.work`. */
export async function pdfPages(args: Record<string, unknown>, where: { work: string; documents?: string | undefined; signal?: AbortSignal }): Promise<PdfPages> {
  const file = await documentPath(args.path, where);
  const maxPages = integer(args.maxPages, 3, 1, MAX_PAGES, "maxPages");
  const dpi = integer(args.dpi, 110, 36, 300, "dpi");
  const name = basename(file);
  const ext = extname(name).toLowerCase();
  const stem = basename(name, extname(name)).replace(/[^A-Za-z0-9._-]+/g, "_") || "doc";
  const signal = where.signal;
  if ([".png", ".jpg", ".jpeg"].includes(ext)) {
    const dir = join(where.work, "pages", stem);
    await mkdir(dir, { recursive: true });
    const out = `1${ext === ".png" ? ".png" : ".jpg"}`;
    const { imageDimensions } = await import("@parcha/agentrun-dsl");
    const size = imageDimensions(new Uint8Array(await readFile(file)));
    if (size && Math.max(size.width, size.height) > MAX_PAGE_PX) {
      const scale = size.width >= size.height ? `${MAX_PAGE_PX}:-2` : `-2:${MAX_PAGE_PX}`;
      await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `scale=${scale}`, "-frames:v", "1", join(dir, out)], { signal, maxBuffer: 1 << 20 }).catch((error: Error) => {
        throw new Error(`pdf_pages: ${name} is ${size.width}x${size.height}, over ${MAX_PAGE_PX} px on a side, and ffmpeg did not scale it: ${error.message.split("\n")[0]}`);
      });
    } else await copyFile(file, join(dir, out));
    return { name, pageCount: 1, dpi: null, pages: [{ page: 1, image: `pages/${stem}/${out}` }], text: "" };
  }
  const info = await run("pdfinfo", [file], { signal, maxBuffer: 1 << 20 }).catch((error: Error) => {
    throw new Error(`pdf_pages: ${name} is not a PDF poppler reads: ${error.message.split("\n")[0]}`);
  });
  const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0);
  const last = Math.min(maxPages, Math.max(pageCount, 1));
  // The largest side of the pages drawn, in points (1/72 in), and the dpi that keeps it within MAX_PAGE_PX.
  const sizes = await run("pdfinfo", ["-f", "1", "-l", String(last), file], { signal, maxBuffer: 1 << 20 }).then((r) => r.stdout, () => info.stdout);
  const points = Math.max(0, ...[...sizes.matchAll(/size:\s+([\d.]+) x ([\d.]+) pts/g)].flatMap((m) => [Number(m[1]), Number(m[2])]));
  // Two pixels short of the cap: pdftoppm rounds a page's size up.
  const used = points > 0 ? Math.max(1, Math.min(dpi, Math.floor(((MAX_PAGE_PX - 2) * 72) / points))) : dpi;
  const dir = join(where.work, "pages", stem, String(used));
  await mkdir(dir, { recursive: true });
  // pdftoppm pads its page numbers to the document's page count: drawn apart, then named by page.
  const temp = await mkdtemp(join(dir, ".draw-"));
  try {
    await run("pdftoppm", ["-png", "-r", String(used), "-f", "1", "-l", String(last), file, join(temp, "p")], { signal, maxBuffer: 1 << 20 });
    const drawn = (await readdir(temp)).filter((f) => /^p-\d+\.png$/.test(f)).map((f) => ({ f, page: Number(/(\d+)\.png$/.exec(f)![1]) })).sort((a, b) => a.page - b.page);
    const pages: PdfPages["pages"] = [];
    for (const { f, page } of drawn) {
      await rename(join(temp, f), join(dir, `${page}.png`));
      pages.push({ page, image: `pages/${stem}/${used}/${page}.png` });
    }
    const { stdout } = await run("pdftotext", ["-l", String(last), "-enc", "UTF-8", file, "-"], { signal, maxBuffer: 16 << 20 });
    const text = stdout.length > TEXT_CAP ? `${stdout.slice(0, TEXT_CAP - 1)}…` : stdout;
    return { name, pageCount, dpi: used, pages, text };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_IMAGE_BYTES = 16 << 20;

/** A decision node's image by its ref, a path under the run's work directory (a page pdf_pages drew), confined to it. */
export const imageLoader = (work: string) => async (ref: string): Promise<{ bytes: Uint8Array; mime: string }> => {
  const mime = IMAGE_TYPES[extname(String(ref)).toLowerCase()];
  if (!mime) throw new Error(`the image ${ref} is not a PNG, JPEG, WebP or GIF file`);
  if (typeof ref !== "string" || isAbsolute(ref)) throw new Error(`the image ${ref} is not a path under the run's work directory`);
  const file = await confined(work, ref);
  if (!file) throw new Error(`the run's work directory has no file ${ref}`);
  if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error(`the image ${ref} is over 16 MiB`);
  return { bytes: new Uint8Array(await readFile(file)), mime };
};
