// The console's build bundles third-party packages into dist/assets (React, its icons, its markdown and sanitizer, its
// fonts). THIRD-PARTY-NOTICES.txt, beside index.html, names each one the bundle holds, read from the bundle itself and not
// from package.json (every chunk's modules, and the file each emitted asset was made from, such as a font a stylesheet
// imports), with its version, its license and its license text. AgentRun Server ships the file with
// the console (packages/serve/scripts/copy-page.mjs), and its NOTICE points to it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path/posix";

export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";
const LICENSE_FILE = /^(?:licen[cs]e|copying|ofl)(?:[.-].*)?$/i;

/** The directory of the package a bundled module id is in (the innermost node_modules), or undefined for the console's
 *  and the repository's own source. Vite's ids use forward slashes; a query or a virtual prefix on one is ignored. */
export function packageDirOf(id) {
  const path = id.replace(/^\0+/, "").split("?")[0].replaceAll("\\", "/");
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = path.slice(at + marker.length).split("/");
  const width = rest[0]?.startsWith("@") ? 2 : 1;
  const parts = rest.slice(0, width);
  if (parts.length < width || parts.some((part) => !part)) return undefined;
  return join(path.slice(0, at + marker.length), ...parts);
}

/** One package's notice: name, version and license as its manifest says, then each of its license files, whole. */
function noticeOf(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type ?? "UNKNOWN";
  const files = readdirSync(dir).filter((name) => LICENSE_FILE.test(name)).sort();
  const texts = files.map((name) => readFileSync(join(dir, name), "utf8").trim());
  return { name: manifest.name, version: manifest.version, license, text: texts.length ? texts.join("\n\n") : `(The package ships no license file; its manifest names ${license}.)` };
}

/** The notices text for the bundled module ids: one section per package, sorted by name, each once. */
export function noticesFor(moduleIds) {
  const dirs = new Set();
  for (const id of moduleIds) {
    const dir = packageDirOf(id);
    if (dir && existsSync(join(dir, "package.json"))) dirs.add(dir);
  }
  const byKey = new Map();
  for (const dir of dirs) {
    const notice = noticeOf(dir);
    byKey.set(`${notice.name}@${notice.version}`, notice);
  }
  const notices = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const head = [
    "Third-party software in the AgentRun console",
    "",
    "The console's build bundles the packages below. Each is listed with its version and license, then its license text.",
    "",
  ];
  // An SPDX expression such as "(MPL-2.0 OR Apache-2.0)" keeps its own parentheses.
  const named = (license) => (license.startsWith("(") && license.endsWith(")") ? license : `(${license})`);
  const body = notices.map((notice) => [`${"-".repeat(78)}`, `${notice.name} ${notice.version} ${named(notice.license)}`, "", notice.text, ""].join("\n"));
  return { packages: notices.map(({ name, version, license }) => ({ name, version, license })), text: `${head.join("\n")}${body.join("\n")}` };
}

/** The Vite plugin: at the end of a build, THIRD-PARTY-NOTICES.txt from every chunk's modules and every asset's source
 *  files (Vite names those relative to its root). */
export function thirdPartyNotices() {
  let root = process.cwd();
  return {
    name: "agentrun-third-party-notices",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((item) => (item.type === "chunk" ? item.moduleIds : (item.originalFileNames ?? []).map((name) => (name.startsWith("/") ? name : join(root, name)))));
      this.emitFile({ type: "asset", fileName: NOTICES_FILE, source: noticesFor(ids).text });
    },
  };
}
