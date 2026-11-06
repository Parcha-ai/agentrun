// The lock Claude Code's first use installs by (src/claude-sdk.ts): harnesses/claude-agent.lock.json, npm's own lock
// (lockfileVersion 3, every package of the tree by sha512) for a package.json that names the Claude Agent SDK at the
// version @parcha/agentrun-harness-claude pins (CLAUDE_AGENT_SDK_VERSION) and nothing else. Made against npm's public
// registry, with no install script run and nothing installed.
//   node scripts/claude-lock.mjs           write it again: run this when the pin moves, and commit the lock
//   node scripts/claude-lock.mjs --check   fail unless its root names the SDK at the pin alone and every package has a sha512
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_AGENT_SDK_VERSION } from "@parcha/agentrun-harness-claude";

const SDK = "@anthropic-ai/claude-agent-sdk";
const LOCK = new URL("../harnesses/claude-agent.lock.json", import.meta.url);

/** What is wrong with `lock` for the pin `version`: none when its root names the SDK at it alone and every package has a sha512. */
export function lockProblems(lock, version = CLAUDE_AGENT_SDK_VERSION) {
  const problems = [];
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion is ${lock.lockfileVersion}, not 3`);
  const root = lock.packages?.[""]?.dependencies ?? {};
  if (JSON.stringify(root) !== JSON.stringify({ [SDK]: version })) problems.push(`its root names ${JSON.stringify(root)}, not ${SDK}@${version} alone: run node scripts/claude-lock.mjs`);
  if (lock.packages?.[`node_modules/${SDK}`]?.version !== version) problems.push(`it installs ${SDK}@${lock.packages?.[`node_modules/${SDK}`]?.version}, not ${version}`);
  for (const [path, entry] of Object.entries(lock.packages ?? {})) if (path && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")) problems.push(`${path} has no sha512`);
  return problems;
}

if (process.argv.includes("--check")) {
  const problems = lockProblems(JSON.parse(readFileSync(LOCK, "utf8")));
  if (problems.length) {
    console.error(`harnesses/claude-agent.lock.json: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`harnesses/claude-agent.lock.json: ${SDK}@${CLAUDE_AGENT_SDK_VERSION}, every package by sha512`);
} else {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-claude-lock-"));
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "agentrun-claude-code", private: true, dependencies: { [SDK]: CLAUDE_AGENT_SDK_VERSION } }, null, 2)}\n`);
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: dir, stdio: "inherit" });
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    const problems = lockProblems(lock);
    if (problems.length) throw new Error(problems.join("; "));
    writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`wrote harnesses/claude-agent.lock.json: ${SDK}@${CLAUDE_AGENT_SDK_VERSION}, ${Object.keys(lock.packages).length - 1} packages`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
