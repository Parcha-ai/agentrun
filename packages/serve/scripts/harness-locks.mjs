// The locks the CLI harnesses' first-use installs go by (src/harness-install.ts): harnesses/<harness>/, a package.json that
// names the harness's package at the version its adapter pins and nothing else, and npm's own lock for it
// (package-lock.json, lockfileVersion 3, every package of the tree by sha512, the CLI's optional platform packages
// included). Made against npm's public registry, with no install script run and nothing installed.
//   node scripts/harness-locks.mjs           write them again: run this when a pin moves, and commit them
//   node scripts/harness-locks.mjs --check   fail unless each names its package at the pin alone and every package has a sha512
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_AGENT_SDK_VERSION } from "@parcha/agentrun-harness-claude";
import { CODEX_VERSION } from "@parcha/agentrun-harness-codex";

/** Each harness that installs on first use: its directory here, the package its install names, and that package's pin. */
export const HARNESS_LOCKS = [
  { id: "claude-agent", name: "agentrun-claude-code", package: "@anthropic-ai/claude-agent-sdk", version: CLAUDE_AGENT_SDK_VERSION },
  { id: "codex", name: "agentrun-codex", package: "@openai/codex", version: CODEX_VERSION },
];

const dirOf = (id) => new URL(`../harnesses/${id}/`, import.meta.url);
/** The package.json a lock is for. */
const manifest = ({ name, package: pkg, version }) => `${JSON.stringify({ name, private: true, dependencies: { [pkg]: version } }, null, 2)}\n`;

/** What is wrong with `lock` for `harness`: none when its root names the package at the pin alone and every package has a
 *  sha512. */
export function lockProblems(lock, { package: pkg, version }) {
  const problems = [];
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion is ${lock.lockfileVersion}, not 3`);
  const root = lock.packages?.[""]?.dependencies ?? {};
  if (JSON.stringify(root) !== JSON.stringify({ [pkg]: version })) problems.push(`its root names ${JSON.stringify(root)}, not ${pkg}@${version} alone: run node scripts/harness-locks.mjs`);
  if (lock.packages?.[`node_modules/${pkg}`]?.version !== version) problems.push(`it installs ${pkg}@${lock.packages?.[`node_modules/${pkg}`]?.version}, not ${version}`);
  for (const [path, entry] of Object.entries(lock.packages ?? {})) if (path && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")) problems.push(`${path} has no sha512`);
  return problems;
}

if (process.argv.includes("--check")) {
  let failed = false;
  for (const harness of HARNESS_LOCKS) {
    const problems = lockProblems(JSON.parse(readFileSync(new URL("package-lock.json", dirOf(harness.id)), "utf8")), harness);
    if (readFileSync(new URL("package.json", dirOf(harness.id)), "utf8") !== manifest(harness)) problems.push("its package.json is not the pin's: run node scripts/harness-locks.mjs");
    if (problems.length) {
      failed = true;
      console.error(`harnesses/${harness.id}: ${problems.join("; ")}`);
    } else console.log(`harnesses/${harness.id}: ${harness.package}@${harness.version}, every package by sha512`);
  }
  if (failed) process.exit(1);
} else {
  for (const harness of HARNESS_LOCKS) {
    const dir = mkdtempSync(join(tmpdir(), "agentrun-harness-lock-"));
    try {
      writeFileSync(join(dir, "package.json"), manifest(harness));
      execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: dir, stdio: "inherit" });
      const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
      const problems = lockProblems(lock, harness);
      if (problems.length) throw new Error(`harnesses/${harness.id}: ${problems.join("; ")}`);
      writeFileSync(new URL("package.json", dirOf(harness.id)), manifest(harness), { flag: "w" });
      writeFileSync(new URL("package-lock.json", dirOf(harness.id)), `${JSON.stringify(lock, null, 2)}\n`);
      console.log(`wrote harnesses/${harness.id}: ${harness.package}@${harness.version}, ${Object.keys(lock.packages).length - 1} packages`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
