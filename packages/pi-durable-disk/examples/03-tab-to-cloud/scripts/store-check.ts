// The browser store in a real browser: pi's storage conformance suite on SQLite-WASM over OPFS (the page is scripts/store-check-page.ts), and a
// database written by one page and read by the next.
//   [CDP=http://127.0.0.1:9333] node scripts/store-check.ts
// The page and the worker are bundled here, into a temporary directory served on loopback; nothing of the check is in tab/dist.
import { build } from "esbuild";
import { createServer } from "node:http";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Cdp } from "./cdp.ts";

const here = import.meta.dirname;
const root = join(here, "..");
const dir = mkdtempSync(join(tmpdir(), "store-check-"));
mkdirSync(join(dir, "vendor"));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };

const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "warning", absWorkingDir: root } as const;
await build({ ...common, entryPoints: ["scripts/store-check-page.ts"], outfile: join(dir, "page.js") });
await build({ ...common, entryPoints: ["tab/sqlite-worker.ts"], outfile: join(dir, "vendor/sqlite-worker.js") });
copyFileSync(join(root, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"), join(dir, "vendor/sqlite3.wasm"));
writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>store check</title><script type="module" src="/page.js"></script>`);

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (file.includes("..")) throw new Error("no");
    const body = readFileSync(join(dir, file));
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));

const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9333");
const device = await cdp.device();
type Result = { phase: string; ok: boolean; total?: number; failed?: { name: string; error: string }[]; detail?: unknown; ms?: number };
const run = async (phase: string): Promise<Result> => {
  const page = await device.open(`http://127.0.0.1:${port}/?phase=${phase}`);
  try {
    await page.until("!!globalThis.__result", 240_000, 250);
    return await page.evaluate<Result>("globalThis.__result");
  } finally {
    await page.close();
  }
};
try {
  const conformance = await run("conformance");
  console.log(`conformance: ${conformance.total} cases in ${conformance.ms} ms, ${conformance.failed?.length ?? "?"} failed`);
  for (const f of conformance.failed ?? []) console.log(`  FAIL ${f.name}: ${f.error}`);
  if (!conformance.total) console.log(JSON.stringify(conformance.detail));
  ok("pi's storage conformance suite passes on SQLite-WASM over OPFS (at least 23 cases)", conformance.ok && (conformance.total ?? 0) >= 23, conformance);
  const wrote = await run("write");
  ok("a page writes a database into OPFS", wrote.ok, wrote);
  const read = await run("read");
  ok("the next page reads what the first wrote", read.ok && JSON.stringify(read.detail) === JSON.stringify([{ a: 41, b: "from the first page" }]), read);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
