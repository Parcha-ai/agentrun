// The install walk's server between a release pull request and its npm publish (install-walk.yml's pack job). The
// launcher pins its server at the release version, and the server pins our other packages at it too; until the publish
// npm has none of them, and an install of this checkout's launcher fails (`No matching version found`). Then the walk
// installs this checkout's own packed packages for exactly the ones npm lacks, and the walk's row says so: never a PASS
// that reads as npm's packages walked.
//   node walk-unpublished.mjs plan <launcher.tgz>
//       the @parcha packages the launcher needs, at their pinned versions, that npm does not have: their names, one
//       line, space separated (nothing when npm has them all). Each must be a workspace here at that version.
//   node walk-unpublished.mjs pack <launcher.tgz> <dir> <dir at walk time>
//       packs each of those (built already: build-workspaces.mjs --only) into <dir>, and points the launcher's and each
//       packed package's dependency on them at `file:<dir at walk time>/<tarball>`, where the walk's jobs download them.
//       Writes <dir>/unpublished.txt (name@version, a line each) and prints the row's words.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isMain } from "../../../scripts/is-main.mjs";

const SCOPE = "@parcha/";
const root = resolve(import.meta.dirname, "..", "..", "..");

/** A tarball's package.json. */
export function manifestOf(tgz) {
  return JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
}

/** The workspaces here by package name: { name: { dir, manifest } }. */
export function workspaces(repo = root) {
  const found = {};
  for (const entry of readdirSync(join(repo, "packages"))) {
    const file = join(repo, "packages", entry, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest.name) found[manifest.name] = { dir: join(repo, "packages", entry), manifest };
  }
  return found;
}

/** Whether npm has name@version. */
export async function onNpm(name, version, registry = "https://registry.npmjs.org") {
  const response = await fetch(`${registry}/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" } });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`${registry} answered ${response.status} for ${name}@${version}`);
  return true;
}

/** The @parcha packages a manifest needs, through each that npm lacks, that npm lacks: [{ name, version, dir, manifest }]
 *  in the order found. `has(name, version)` says whether npm has it; a package npm has brings its own from npm. */
export async function unpublished(manifest, local, has) {
  const need = [];
  const seen = new Set();
  const visit = async (deps) => {
    for (const [name, version] of Object.entries(deps ?? {})) {
      if (!name.startsWith(SCOPE) || seen.has(`${name}@${version}`)) continue;
      seen.add(`${name}@${version}`);
      if (await has(name, version)) continue;
      const workspace = local[name];
      if (!workspace) throw new Error(`npm has no ${name}@${version}, and no workspace here is ${name}`);
      if (workspace.manifest.version !== version) throw new Error(`npm has no ${name}@${version}, and the workspace here is ${name}@${workspace.manifest.version}`);
      need.push({ name, version, ...workspace });
      await visit({ ...workspace.manifest.dependencies, ...workspace.manifest.optionalDependencies });
    }
  };
  await visit({ ...manifest.dependencies, ...manifest.optionalDependencies });
  return need;
}

/** A manifest with each dependency on a packed package pointed at its tarball: `packed` maps a name to its spec. */
export function pointAt(manifest, packed) {
  const out = structuredClone(manifest);
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(out[field] ?? {})) if (packed[name]) out[field][name] = packed[name];
  }
  return out;
}

/** The row's words: which packages npm lacks and that this checkout's packed ones stand in. */
export function rowWords(need) {
  const [first, ...rest] = need;
  return `npm has no ${first.name}@${first.version} yet: walked with this checkout's packed ${need.map((p) => p.name).join(", ")}${rest.length ? ` (${need.length} packages)` : ""}, not npm's`;
}

/** Writes a tarball again with `manifest` as its package.json. */
export function repack(tgz, manifest) {
  const work = mkdtempSync(join(tmpdir(), "walk-unpublished-"));
  execFileSync("tar", ["-xzf", tgz, "-C", work]);
  writeFileSync(join(work, "package", "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  execFileSync("tar", ["-czf", tgz, "-C", work, "package"]);
}

async function main([command, launcher, dir, walkDir]) {
  const need = await unpublished(manifestOf(launcher), workspaces(), (name, version) => onNpm(name, version));
  if (command === "plan") return console.log(need.map((p) => p.name).join(" "));
  if (command !== "pack" || !dir || !walkDir) throw new Error("usage: walk-unpublished.mjs plan <launcher.tgz> | pack <launcher.tgz> <dir> <dir at walk time>");
  if (!need.length) return;
  const packed = {};
  const files = {};
  for (const p of need) {
    const file = execFileSync("npm", ["pack", p.dir, "--pack-destination", dir, "--ignore-scripts", "--silent"], { encoding: "utf8" }).trim().split("\n").pop();
    files[p.name] = join(dir, file);
    packed[p.name] = `file:${walkDir}/${basename(file)}`;
  }
  for (const tgz of [launcher, ...Object.values(files)]) repack(tgz, pointAt(manifestOf(tgz), packed));
  writeFileSync(join(dir, "unpublished.txt"), need.map((p) => `${p.name}@${p.version}\n`).join(""));
  console.log(rowWords(need));
}

if (isMain(import.meta)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`walk-unpublished: ${error.message}`);
    process.exitCode = 1;
  });
}
