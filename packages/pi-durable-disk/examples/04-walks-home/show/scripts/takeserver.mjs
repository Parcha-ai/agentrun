// Start the take server (take-server.mjs) from a script or a test and wait until it is up, or fail at once if it exits.
// Returns { child, status } where status holds the origin and the PATHS of the token and link files, never their contents.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForFile } from "./cdp.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "take-server.mjs");

export async function startTakeServer({ dir, disk, cloud = "remote-local", ms = 90_000 }) {
  const child = spawn(process.execPath, [script, "--local", disk, "--dir", dir, "--cloud", cloud], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), TMPDIR: join(homedir(), "tmp-d5", "tmp") },
    stdio: "ignore",
  });
  // The status file is written last, after the server answers and the link file exists.
  await waitForFile(join(dir, "status.json"), child, ms);
  return { child, status: JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) };
}
