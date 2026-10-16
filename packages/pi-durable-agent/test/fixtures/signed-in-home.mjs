// A signed-in agent home for exporter tests. Its saved sign-in is a marker that no export may contain, in its rows or
// anywhere in its bytes: SQLite keeps a deleted row's bytes in free pages until the file is rewritten.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDocFamily } from "@earendil-works/pi-durable";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_STORE_FILE, carryBack, createAgentHome, durableProfileStore, setAlias, setBindings, startRun } from "../../dist/index.js";

export const SIGN_IN_MARKER = "ctx-FAKE-SIGNIN-0000";
export const PRACTICE_ORIGIN = "https://practice-site.example";
export const FIXTURE_HOST = "fixture-host";
/** Why `buildSignedInHome` cannot run on this platform, or undefined: pi-durable-disk runs a local directory on Linux
 *  only. Pass it as a test's `skip`. */
export const signedInHomeSkip = process.platform === "linux" ? undefined : "pi-durable-disk runs a local directory on Linux only";

const Profiles = defineDocFamily({ kind: "browser.profiles", version: 1, scope: "session", family: true, initial: () => ({}) });

/** An agent home in `dir/home` after one run under pi-durable-disk signed in to the practice site and was carried back:
 *  the marker is the profile's `ref` in both `agent.sqlite` and the run's `store/run.sqlite`. */
export async function buildSignedInHome(dir) {
  if (signedInHomeSkip) throw new Error(signedInHomeSkip);
  const home = await createAgentHome(path.join(dir, "home"), {
    definition: { version: 1, name: "Signed-in fixture", instructions: "Use the practice site.", skills: ["practice"], tools: ["browser"] },
    skills: { "practice/SKILL.md": "# Practice\n\nSign in, then read the page.\n" },
  });
  await setAlias(home, FIXTURE_HOST, "ext-fixture-1");
  await setBindings(home, FIXTURE_HOST, { browser: "local" });
  const run = await startRun(home, { runId: "signed-in", host: FIXTURE_HOST });
  const durable = await openDurableRun({ disk: "local", region: "local", id: run.runId }, { ...localRun(run.dir), harness: { models: createModels(), registry: createRegistry() } });
  try {
    await durable.harness.root(BACKGROUND_CONTEXT, { agent: { instructions: run.agent.instructions } });
    await durable.harness.commit(async (tx) => {
      Object.assign(await tx.doc(Profiles, "practice", null), { provider: "browserbase", ref: "", state: "new", allowedOrigins: [PRACTICE_ORIGIN] });
    }, BACKGROUND_CONTEXT);
    const ref = await durableProfileStore(durable.harness).resolve("practice", async () => SIGN_IN_MARKER);
    if (ref !== SIGN_IN_MARKER) throw new Error(`the practice profile resolved to ${ref}, not the marker`);
  } finally {
    await durable.release();
  }
  const back = await carryBack(home, run, { outcome: "completed", finalAnswer: "Signed in to the practice site." });
  if (!back.profiles.includes("practice")) throw new Error("the carry back did not copy the practice profile");
  return { home, runId: run.runId, agentStore: path.join(home.dir, AGENT_STORE_FILE), runStore: run.storePath };
}

const MARKER_BYTES = [Buffer.from(SIGN_IN_MARKER, "utf8"), Buffer.from(SIGN_IN_MARKER, "utf16le"), Buffer.from(SIGN_IN_MARKER, "utf16le").swap16()];

/** Throw unless the export at `file` is one closed SQLite file with no trace of the sign-in: no `-wal`, `-shm` or
 *  `-journal` beside it, and the marker nowhere in its bytes (UTF-8 or UTF-16), whether in a row or a free page. */
export function checkExportClean(file) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${file}${suffix}`)) throw new Error(`${path.basename(file)}${suffix} sits beside the export: it is not one closed file`);
  }
  const bytes = readFileSync(file);
  if (MARKER_BYTES.some((marker) => bytes.includes(marker))) throw new Error(`the export ${path.basename(file)} holds the sign-in marker in its bytes`);
}
