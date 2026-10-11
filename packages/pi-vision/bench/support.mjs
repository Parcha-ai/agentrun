// Shared by the bench files, which run one per process (bench/run.mjs). Each file builds its synthetic files, runs one
// provider job over them under the clock, and prints one table. A provider that is not built prints `not built` in place
// of its rows; one that is built but cannot run here prints what its detection needs. A job that throws prints the first
// line of its error, so a failure shows in the table.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { detectOnce, NotBuiltError } from "@parcha/pi-vision";
import { nodeVisionEnv } from "@parcha/pi-vision/node";

export const HEADER = ["provider", "job", "file", "ms", "bytes", "pixels", "peak RSS MB"];
export const sharpFactory = (input, options) => sharp(input, options);
export const peakRssMb = () => Math.round(process.resourceUsage().maxRSS / 1024);

/** Writes each file into `dir`; returns, by name, its bytes, its page (for a render) and the source a provider reads. */
export async function writeFiles(dir, entries) {
  const files = {};
  for (const [name, { kind, bytes, page }] of Object.entries(entries)) {
    const path = await dir.file(name, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files[name] = { bytes, page, source: { path, kind, bytes: bytes.length, sha256 } };
  }
  return files;
}

/** `make()`'s value, or undefined when that part is not built in this release. */
function builtOr(make) {
  try {
    return make();
  } catch (error) {
    if (error instanceof NotBuiltError) return undefined;
    throw error;
  }
}

/** The provider and its environment, or the reason it cannot run there. */
async function runnable(make, makeEnv) {
  const provider = builtOr(make);
  const env = provider && builtOr(makeEnv);
  if (!env) return { skip: "not built" };
  const detection = await detectOnce(provider, env);
  return detection.available ? { provider, env } : { skip: `unavailable, needs ${detection.needs}` };
}

/** One job of one provider over the files (or the `names` among them): a row per file, or one row saying why it did not
 *  run. The environment is the Node one in `cwd` unless `env` gives another. */
export async function jobRows({ label, job, make, cwd, files, names, run, env = () => nodeVisionEnv({ cwd }) }) {
  const found = await runnable(make, env);
  if (found.skip) return [[label, job, "-", found.skip, "-", "-", "-"]];
  const call = { env: found.env, signal: undefined, tempDir: cwd };
  const rows = [];
  for (const [name, file] of Object.entries(files)) {
    if (names && !names.includes(name)) continue;
    const started = performance.now();
    try {
      const out = await run(found.provider, file, call);
      rows.push([label, job, name, (performance.now() - started).toFixed(1), out.bytes, out.pixels, peakRssMb()]);
    } catch (error) {
      rows.push([label, job, name, `error: ${String(error?.message ?? error).split("\n")[0]}`, "-", "-", peakRssMb()]);
    }
  }
  return rows;
}

/** Prints a title, then the header and rows, aligned in columns. */
export function table(title, header, rows) {
  const all = [header, ...rows].map((row) => row.map(String));
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  console.log(`\n${title}`);
  for (const row of all) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
}
