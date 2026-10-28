// Run with an inherited descriptor 3 (not close-on-exec) and PI_TRANSPORT_SECRETS_FD=3, as transport's launcher starts a
// program: closes it as the instance does when CLOSE=1, then prints the descriptors and the environment a command it
// spawns sees.
import { spawnSync } from "node:child_process";
import { closeSecretsFd } from "../../src/cli.ts";

if (process.env.CLOSE === "1") closeSecretsFd(process.env);
const r = spawnSync("sh", ["-c", "ls /proc/$$/fd; echo SECRETS_FD=${PI_TRANSPORT_SECRETS_FD:-unset}"], { encoding: "utf8", env: process.env });
process.stdout.write(r.stdout);
