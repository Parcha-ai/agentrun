// pdf_pages: a document's first pages as PNG files in the run's work directory, and its text, for a workflow's call node
// `via: "tool"`. The document is a file name under the server's documents directory (`--documents`,
// AGENTRUN_SERVE_DOCUMENTS) or the run's work directory, read through the run's Workspace (which follows no link). Pages
// are drawn by poppler's pdftoppm in a scratch folder of this server's, then written through the run's Workspace to
// `pages/<stem>/<dpi>/<n>.png`, the stem the document's own (pagesStem), at the asked dpi lowered so a page's long side
// stays within MAX_PAGE_PX (Jev's image limit); the dpi used is in the answer and the path, so a draw at another dpi
// never replaces an image an earlier receipt points to. A PNG or JPEG passes through as its one page, scaled down with
// ffmpeg when a side is over the cap. The image refs it answers are work-relative, the form a decision node's `images`
// takes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { helperEnv } from "./helper-env.js";
import { isWorkspaceError, READ_MAX, relativePath, type Workspace, workspaceAt } from "./workspace/index.js";

export const PDF_PAGES_TOOL = "pdf_pages";
/** The read-only directory a run's documents are read from: the server's `--documents`. */
export const DOCUMENTS_ENV = "AGENTRUN_SERVE_DOCUMENTS";
const TEXT_CAP = 20_000;
const MAX_PAGES = 50;
/** The longest side a drawn page may have, in pixels: Jev's image limit (1568 per side; 1569 is refused). */
export const MAX_PAGE_PX = 1568;
// Each helper starts with helperEnv(): PATH, the locale and TMPDIR, never the server's secrets (helper-env.ts).
const run = promisify(execFile);

/** `dpi`: the dpi the pages were drawn at (at most the asked one); null for an image that passed through. */
export type PdfPages = { name: string; pageCount: number; dpi: number | null; pages: { page: number; image: string }[]; text: string };

/** Where pdf_pages reads and draws: the run's Workspace, the server's documents directory when it has one. */
export type PdfWhere = { work: Workspace; documents?: string | undefined; signal?: AbortSignal };

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

/** A document found: which of the two holds it, its path below that one, its name, and its bytes' place on this
 *  server (the documents' own file, or a scratch copy of the run's). */
type Located = { base: "documents" | "work"; rel: string; name: string; file: string };

/** `path` as the run's Workspace names it, or undefined for one that would leave the work directory. */
function workPath(path: string): string | undefined {
  try {
    const rel = relativePath(posix.normalize(path));
    return rel === "" ? undefined : rel;
  } catch {
    return undefined;
  }
}

/** Where a document named `path` is, the documents directory first (links resolved, never outside it), then the run's
 *  work directory through its Workspace (no link followed), copied into `scratch` to be drawn from. */
async function locate(path: unknown, where: PdfWhere, scratch: string): Promise<Located> {
  if (typeof path !== "string" || !path.trim()) throw new Error("pdf_pages: path is a file name");
  if (isAbsolute(path)) throw new Error(`pdf_pages: path ${path} is absolute; name a file under the documents or the run's work directory`);
  if (where.documents) {
    const found = await confined(where.documents, path);
    if (found) return { base: "documents", rel: relative(await realpath(where.documents), found).split(sep).join("/"), name: basename(found), file: found };
  }
  const rel = workPath(path);
  const bytes = rel === undefined ? undefined : await where.work.read(rel).catch((error: unknown) => {
    if (isWorkspaceError(error, "TOO_LARGE")) throw new Error(`pdf_pages: ${path} is over ${READ_MAX} bytes`);
    if (isWorkspaceError(error) && error.code !== "UNAVAILABLE" && error.code !== "TIMEOUT") return undefined;
    throw error;
  });
  if (rel === undefined || bytes === undefined) throw new Error(`pdf_pages: no file ${path} under the documents${where.documents ? "" : " (this server has no --documents)"} or the run's work directory`);
  const name = posix.basename(rel);
  const file = join(scratch, `document${extname(name).toLowerCase()}`);
  await writeFile(file, bytes);
  return { base: "work", rel, name, file };
}

/** The one directory name a document's pages are drawn under, in `work/pages/`: its path below the documents (or work)
 *  directory without the extension, each run of other characters than letters, digits, `.`, `_` and `-` (a `/` too)
 *  made `_`, cut to its last 48 characters with no leading dot, then `-` and 12 hex characters of the sha256 of which
 *  directory and that path. So two documents of one file name in different folders never share a page, the same file
 *  always draws under the same name (through a link too), and the name is never a separator, `.` or `..`. */
export function pagesStem({ base, rel }: Pick<Located, "base" | "rel">): string {
  const path = rel.split(sep).join("/");
  const readable = path.slice(0, path.length - extname(path).length).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-48).replace(/^\.+/, "") || "doc";
  return `${readable}-${createHash("sha256").update(`${base}:${path}`).digest("hex").slice(0, 12)}`;
}

const integer = (value: unknown, fallback: number, min: number, max: number, name: string) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`pdf_pages: ${name} is an integer from ${min} to ${max}`);
  return value;
};

/** The pages and text of the document `args.path`, drawn in a scratch folder and written through the run's Workspace. */
export async function pdfPages(args: Record<string, unknown>, where: PdfWhere): Promise<PdfPages> {
  const scratch = await mkdtemp(join(tmpdir(), "agentrun-pdf-pages-"));
  try {
    return await drawn(args, where, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function drawn(args: Record<string, unknown>, where: PdfWhere, scratch: string): Promise<PdfPages> {
  const located = await locate(args.path, where, scratch);
  const { file, name } = located;
  const maxPages = integer(args.maxPages, 3, 1, MAX_PAGES, "maxPages");
  const dpi = integer(args.dpi, 110, 36, 300, "dpi");
  const ext = extname(name).toLowerCase();
  const stem = pagesStem(located);
  const signal = where.signal;
  if ([".png", ".jpg", ".jpeg"].includes(ext)) {
    const out = `1${ext === ".png" ? ".png" : ".jpg"}`;
    const { imageDimensions } = await import("@parcha/agentrun-dsl");
    const bytes = new Uint8Array(await readFile(file));
    const size = imageDimensions(bytes);
    let page = bytes;
    if (size && Math.max(size.width, size.height) > MAX_PAGE_PX) {
      const scale = size.width >= size.height ? `${MAX_PAGE_PX}:-2` : `-2:${MAX_PAGE_PX}`;
      const scaled = join(scratch, `scaled${ext === ".png" ? ".png" : ".jpg"}`);
      await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `scale=${scale}`, "-frames:v", "1", scaled], { signal, maxBuffer: 1 << 20, env: helperEnv() }).catch((error: Error) => {
        throw new Error(`pdf_pages: ${name} is ${size.width}x${size.height}, over ${MAX_PAGE_PX} px on a side, and ffmpeg did not scale it: ${error.message.split("\n")[0]}`);
      });
      page = new Uint8Array(await readFile(scaled));
    }
    await where.work.write(`pages/${stem}/${out}`, page);
    return { name, pageCount: 1, dpi: null, pages: [{ page: 1, image: `pages/${stem}/${out}` }], text: "" };
  }
  const info = await run("pdfinfo", [file], { signal, maxBuffer: 1 << 20, env: helperEnv() }).catch((error: Error) => {
    throw new Error(`pdf_pages: ${name} is not a PDF poppler reads: ${error.message.split("\n")[0]}`);
  });
  const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0);
  const last = Math.min(maxPages, Math.max(pageCount, 1));
  // The largest side of the pages drawn, in points (1/72 in), and the dpi that keeps it within MAX_PAGE_PX.
  const sizes = await run("pdfinfo", ["-f", "1", "-l", String(last), file], { signal, maxBuffer: 1 << 20, env: helperEnv() }).then((r) => r.stdout, () => info.stdout);
  const points = Math.max(0, ...[...sizes.matchAll(/size:\s+([\d.]+) x ([\d.]+) pts/g)].flatMap((m) => [Number(m[1]), Number(m[2])]));
  // Two pixels short of the cap: pdftoppm rounds a page's size up.
  const used = points > 0 ? Math.max(1, Math.min(dpi, Math.floor(((MAX_PAGE_PX - 2) * 72) / points))) : dpi;
  // pdftoppm pads its page numbers to the document's page count: drawn apart, then named by page.
  const out = await mkdtemp(join(scratch, "draw-"));
  await run("pdftoppm", ["-png", "-r", String(used), "-f", "1", "-l", String(last), file, join(out, "p")], { signal, maxBuffer: 1 << 20, env: helperEnv() });
  const pngs = (await readdir(out)).filter((f) => /^p-\d+\.png$/.test(f)).map((f) => ({ f, page: Number(/(\d+)\.png$/.exec(f)![1]) })).sort((a, b) => a.page - b.page);
  const pages: PdfPages["pages"] = [];
  for (const { f, page } of pngs) {
    await where.work.write(`pages/${stem}/${used}/${page}.png`, await readFile(join(out, f)));
    pages.push({ page, image: `pages/${stem}/${used}/${page}.png` });
  }
  const { stdout } = await run("pdftotext", ["-l", String(last), "-enc", "UTF-8", file, "-"], { signal, maxBuffer: 16 << 20, env: helperEnv() });
  const text = stdout.length > TEXT_CAP ? `${stdout.slice(0, TEXT_CAP - 1)}…` : stdout;
  return { name, pageCount, dpi: used, pages, text };
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_IMAGE_BYTES = 16 << 20;

/** A decision node's image by its ref, a path under the run's work directory (a page pdf_pages drew), read through the
 *  run's Workspace (the run's process still hands its folder's path). */
export const imageLoader = (given: Workspace | string) => async (ref: string): Promise<{ bytes: Uint8Array; mime: string }> => {
  const work = workspaceAt(given);
  const mime = IMAGE_TYPES[extname(String(ref)).toLowerCase()];
  if (!mime) throw new Error(`the image ${ref} is not a PNG, JPEG, WebP or GIF file`);
  const rel = typeof ref === "string" && !isAbsolute(ref) ? workPath(ref) : undefined;
  if (rel === undefined) throw new Error(`the image ${ref} is not a path under the run's work directory`);
  // One byte past the cap tells a file over it from one at it.
  const bytes = await work.read(rel, { length: MAX_IMAGE_BYTES + 1 }).catch((error: unknown) => {
    if (isWorkspaceError(error) && error.code !== "UNAVAILABLE" && error.code !== "TIMEOUT") throw new Error(`the run's work directory has no file ${ref}`);
    throw error;
  });
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`the image ${ref} is over 16 MiB`);
  return { bytes, mime };
};
