// Proves the installed path: `npm pack`, install the tarball into an empty project, then on each Node given
//   - import every entry of `exports` with type stripping switched off, so nothing can lean on it;
//   - run the CLI (no command: usage on stderr, exit 2);
//   - typecheck an `import` of every entry with tsc (nodenext, strict) in an empty TypeScript project.
// Needs the npm registry (the peers and typescript are installed from it). Usage:
//   node scripts/verify-tarball.mjs [--node DIR ...]     DIR holds the `node` to try (default: the Node running this)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { node: { type: "string", multiple: true } } });
const nodes = values.node?.length ? values.node : [dirname(process.execPath)];
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: "utf8", ...options });
const failures = [];
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n${String(detail).trim().split("\n").slice(0, 12).map((l) => `       ${l}`).join("\n")}`}`);
  if (!ok) failures.push(what);
};

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-tarball-"));
try {
  const pack = run("npm", ["pack", "--pack-destination", work, "--json"], { cwd: ROOT });
  if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stderr}`);
  const tarball = join(work, JSON.parse(pack.stdout)[0].filename);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const peers = Object.keys(pkg.peerDependencies ?? {}).map((name) => `${name}@${pkg.devDependencies?.[name]?.replace(/^[\^~]/, "") ?? "latest"}`);

  const app = join(work, "consumer");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  const install = run("npm", ["install", "--no-audit", "--no-fund", tarball, ...peers, "@earendil-works/pi-ai", "typescript@5.9", "@types/node@24"], { cwd: app });
  check(`npm install of ${pkg.name}@${pkg.version} from its tarball`, install.status === 0, install.stderr);
  if (install.status !== 0) throw new Error("cannot go on without an installed package");

  const entries = Object.entries(pkg.exports).filter(([key, target]) => typeof target === "object" && target.default);
  const specifier = (key) => (key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`);
  const cli = join(app, "node_modules", pkg.name, Object.values(pkg.bin)[0]);

  for (const dir of nodes) {
    const bin = join(dir, "node");
    const version = run(bin, ["--version"]).stdout.trim();
    const env = { PATH: `${dir}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/", NODE_NO_WARNINGS: "1" };
    for (const [key] of entries) {
      const r = run(bin, ["--no-experimental-strip-types", "--input-type=module", "-e", `const m = await import(${JSON.stringify(specifier(key))}); console.log(Object.keys(m).length)`], { cwd: app, env });
      check(`node ${version}, no type stripping: import "${specifier(key)}" (${r.stdout.trim()} exports)`, r.status === 0 && Number(r.stdout) > 0, r.stderr);
    }
    const wrapper = run(bin, ["--no-experimental-strip-types", "--input-type=module", "-e", `import { existsSync } from "node:fs"; import { ARCHIL_SCOPED } from ${JSON.stringify(pkg.name)}; process.exit(existsSync(ARCHIL_SCOPED) ? 0 : 1)`], { cwd: app, env });
    check(`node ${version}: ARCHIL_SCOPED names the shipped wrapper`, wrapper.status === 0, wrapper.stderr);
    const usage = run(bin, ["--no-experimental-strip-types", cli], { cwd: app, env });
    check(`node ${version}, no type stripping: the CLI prints its usage and exits 2`, usage.status === 2 && /usage:/.test(usage.stderr), `${usage.status}\n${usage.stderr}`);
  }

  // Every entry typechecks from the installed package. Errors inside the package's own declarations fail; errors in
  // other packages' declarations (skipLibCheck is off so ours are really checked) are listed and ignored.
  const imports = entries.map(([key], i) => `import * as entry${i} from ${JSON.stringify(specifier(key))};`).join("\n");
  writeFileSync(join(app, "check.ts"), `${imports}\n${entries.map((_, i) => `void entry${i};`).join("\n")}\n// @ts-expect-error a type that resolves to any would make this directive unused\nconst notANumber: number = (entry0 as { ARCHIL_SCOPED: string }).ARCHIL_SCOPED;\nvoid notANumber;\n`);
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: ["node"] }, include: ["check.ts"] }));
  const tsc = run(process.execPath, [join(app, "node_modules/typescript/bin/tsc"), "-p", app], { cwd: app });
  const lines = `${tsc.stdout}${tsc.stderr}`.split("\n").filter((l) => /error TS\d+/.test(l));
  const ours = lines.filter((l) => l.startsWith(`node_modules/${pkg.name}/`) || l.startsWith("check.ts"));
  check(`tsc: an import of ${entries.map(([key]) => `"${specifier(key)}"`).join(" and ")} typechecks (${lines.length - ours.length} errors in other packages' declarations ignored)`, ours.length === 0, ours.join("\n"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nthe installed package works");
