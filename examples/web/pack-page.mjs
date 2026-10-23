#!/usr/bin/env node
// Pack the run page as a self-contained replay: `node examples/web/pack-page.mjs <outDir> [--data ./data/]`. It writes
// index.html (with its Content-Security-Policy as a meta tag: a static host sets no headers), replay.js, run-page.js,
// source.js, app.css and timeline/ (@parcha/pi-durable-agent's built timeline). The page reads the replay from the
// `--data` address, relative to the page (default ./data/), which `writeReplay` (replay.mjs) fills. Every URL in the
// bundle is relative, so it works under any path.
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = import.meta.dirname;
const TIMELINE = dirname(fileURLToPath(import.meta.resolve("@parcha/pi-durable-agent/timeline")));
/** The page's own files only; agent-written HTML in a file view has its own frame, sandboxed with nothing allowed. */
export const REPLAY_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

const attr = (value) => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Write the replay page into `outDir`; `data` is where it reads the replay, relative to the page. */
export async function packPage(outDir, { data = "./data/" } = {}) {
  if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(data)) throw new Error(`--data must be relative to the page, not ${JSON.stringify(data)}`);
  const out = resolve(outDir);
  await mkdir(join(out, "timeline"), { recursive: true });
  for (const file of ["replay.js", "run-page.js", "source.js", "app.css"]) await copyFile(join(HERE, "page", file), join(out, file));
  for (const file of (await readdir(TIMELINE)).filter((f) => f.endsWith(".js"))) await copyFile(join(TIMELINE, file), join(out, "timeline", file));
  await writeFile(
    join(out, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPLAY_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="replay-data" content="${attr(data.endsWith("/") ? data : `${data}/`)}">
<title>AgentRun replay</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="replay.js"></script>
</body>
</html>
`,
  );
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { data: { type: "string", default: "./data/" } } });
  if (positionals.length !== 1) {
    console.error("usage: pack-page.mjs <outDir> [--data ./data/]");
    process.exit(2);
  }
  console.log(`replay page in ${await packPage(positionals[0], { data: values.data })} (data: ${values.data})`);
}
