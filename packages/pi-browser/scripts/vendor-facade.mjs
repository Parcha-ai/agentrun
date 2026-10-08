#!/usr/bin/env node
/** The vendored Stagehand facade (src/vendor/stagehand-facade/): upstream's files, byte for byte, at one commit of the
 *  Stagehand monorepo (github.com/browserbase/stagehand, packages/integrations/core/src/facade). UPSTREAM.json names
 *  the commit, the release it is, and each file's git blob id and SHA-256; nothing else lives in the directory.
 *
 *  Usage: node scripts/vendor-facade.mjs --check
 *           the vendored files are exactly the ones UPSTREAM.json lists, with its blob ids and SHA-256s (no network)
 *         node scripts/vendor-facade.mjs --commit SHA --release NAME
 *           fetch UPSTREAM.json's files at SHA, refuse any whose git blob id differs from the one GitHub lists for that
 *           commit or that imports a file the manifest does not list, then write them and UPSTREAM.json
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FACADE_DIR = path.join(ROOT, "src/vendor/stagehand-facade");
const MANIFEST = "UPSTREAM.json";
const REPO = "browserbase/stagehand";
const UPSTREAM_DIR = "packages/integrations/core/src/facade";

/** Git's object id for a file's bytes: what a commit's tree lists for it. */
export const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every way the vendored directory differs from its manifest; empty when it matches byte for byte. */
export function checkVendored(dir = FACADE_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
  const problems = [];
  const listed = Object.keys(manifest.files);
  for (const name of fs.readdirSync(dir)) if (name !== MANIFEST && !listed.includes(name)) problems.push(`${name} is not in ${MANIFEST}`);
  for (const [name, want] of Object.entries(manifest.files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { problems.push(`${name} is missing`); continue; }
    const bytes = fs.readFileSync(file);
    if (blobId(bytes) !== want.blob) problems.push(`${name}: blob ${blobId(bytes)}, upstream ${want.blob} at ${manifest.commit}`);
    if (sha256(bytes) !== want.sha256) problems.push(`${name}: sha256 ${sha256(bytes)}, manifest ${want.sha256}`);
  }
  return { manifest, problems };
}

async function fetchOk(url, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": "agentrun-pi-browser-vendor-facade", ...headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** Every relative module a file names: `from "./x.js"` (import and export), a side-effect `import "./x.js"`, and a
 *  dynamic `import("./x.js")`, with any spacing. */
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/** Each relative import of the fetched files that `listed` does not hold, as `<file> imports <spec>` with the file it
 *  names; empty when the set is closed. */
export function unlistedImports(fetched, listed) {
  const missing = [];
  for (const [name, bytes] of fetched) {
    for (const [, spec] of bytes.toString("utf8").matchAll(RELATIVE_IMPORT)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec)).replace(/\.js$/, ".ts");
      if (!listed.has(target)) missing.push({ name, spec, target });
    }
  }
  return missing;
}

const github = {
  listing: async (commit) => {
    const entries = await (await fetchOk(`https://api.github.com/repos/${REPO}/contents/${UPSTREAM_DIR}?ref=${commit}`, { accept: "application/vnd.github+json" })).json();
    return new Map(entries.filter((entry) => entry.type === "file").map((entry) => [entry.name, entry.sha]));
  },
  read: async (commit, name) => Buffer.from(await (await fetchOk(`https://raw.githubusercontent.com/${REPO}/${commit}/${UPSTREAM_DIR}/${name}`)).arrayBuffer()),
};

/** Vendor the manifest's files at `commit` into `dir`. Every check runs before the first write, so a refused refresh
 *  leaves `dir` as it was. `io` is GitHub unless a caller (a test) passes its own listing and reader. */
export async function vendor(commit, release, { dir = FACADE_DIR, io = github } = {}) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit takes a full 40-character commit SHA");
  // The release names the bytes: a new commit never inherits the last one's name.
  if (!release) throw new Error("--commit needs --release NAME (the Stagehand release that commit is)");
  const current = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
  const blobs = await io.listing(commit);
  const files = {};
  const fetched = new Map();
  for (const name of Object.keys(current.files)) {
    if (!blobs.has(name)) throw new Error(`${UPSTREAM_DIR}/${name} is not in ${commit}`);
    const bytes = await io.read(commit, name);
    if (blobId(bytes) !== blobs.get(name)) throw new Error(`${name}: fetched blob ${blobId(bytes)}, ${commit} lists ${blobs.get(name)}`);
    fetched.set(name, bytes);
    files[name] = { blob: blobId(bytes), sha256: sha256(bytes) };
  }
  // The vendored set is closed under relative imports: a file upstream added and a listed file imports fails the
  // refresh by name (add it to UPSTREAM.json), instead of a copy the offline check would pass.
  const missing = unlistedImports(fetched, new Set(Object.keys(files)));
  if (missing.length) throw new Error(missing.map(({ name, spec, target }) => `${name} imports ${spec}, which ${MANIFEST} does not list: add ${target} (from ${UPSTREAM_DIR}) to it`).join("\n"));
  for (const [name, bytes] of fetched) fs.writeFileSync(path.join(dir, name), bytes);
  const manifest = { repo: `github.com/${REPO}`, path: UPSTREAM_DIR, commit, release, files };
  fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  if (argv.includes("--check")) {
    const { manifest, problems } = checkVendored();
    if (problems.length) { for (const p of problems) process.stderr.write(`vendor-facade: ${p}\n`); process.exit(1); }
    process.stdout.write(`vendor-facade: ${Object.keys(manifest.files).length} files match ${manifest.commit} (${manifest.release})\n`);
  } else if (value("--commit")) {
    const manifest = await vendor(value("--commit"), value("--release"));
    process.stdout.write(`vendor-facade: vendored ${Object.keys(manifest.files).length} files at ${manifest.commit}\n`);
  } else {
    process.stderr.write("usage: vendor-facade.mjs --check | --commit SHA --release NAME\n");
    process.exit(2);
  }
}
