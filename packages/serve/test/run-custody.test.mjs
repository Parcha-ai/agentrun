// A run's code reaches its own model's key and nothing else the server holds. The server is started by its launcher with
// every secret it names set to a canary (the seal key a key it takes, the token list an id and a 32-character secret);
// a pi run on an OpenAI model answers, through the faux model (fixtures/faux-custody.mjs), which secrets the process its
// loop runs in answers secret(name) for. Its process answers OpenAI's key alone: never the server's token, its token
// list, its API key or its seal key, nor another provider's key or a box's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_NAMES } from "../dist/secrets.js";
import { client, LAUNCH_HOOK_URL, launchHookCanary, printed } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const CUSTODY = new URL("./fixtures/faux-custody.mjs", import.meta.url).pathname;
/** The server's own, which no run is ever handed. */
const SERVER_ONLY = ["AGENTRUN_TOKEN", "AGENTRUN_TOKENS", "AGENTRUN_API_KEY", "AGENTRUN_SEAL_KEY", "AGENTRUN_STORE_URL"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server under its launcher, in a process group of its own, with every secret it names set to a canary. */
async function launched(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-custody-"));
  const canary = `nak-${process.pid}-${Date.now().toString(36)}`;
  const secrets = Object.fromEntries(
    SECRET_NAMES.map((name, i) => [
      name,
      name === "AGENTRUN_TOKEN" ? `${canary}-token-0123456789abcdef` : name === "AGENTRUN_TOKENS" ? `custody:${canary}-tokens-0123456789abcdef0123456789` : name === "AGENTRUN_SEAL_KEY" ? randomBytes(32).toString("base64") : name === "AGENTRUN_LAUNCH_HOOK_SECRET" ? launchHookCanary(`${canary}-${i}`) : name === "AGENTRUN_STORE_URL" ? undefined : `${canary}-${i}`,
    ]),
  );
  const env = { ...process.env, ...LAUNCH_HOOK_URL, ...secrets, XDG_CONFIG_HOME: join(dir, "config"), TMPDIR: dir };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const child = spawn(LAUNCHER, ["--data", join(dir, "data"), "--port", "0", "--faux", CUSTODY], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
  let alive = true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve((alive = false))));
  t.after(async () => {
    if (alive) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await Promise.race([exited, sleep(10_000)]);
    await rm(dir, { recursive: true, force: true });
  });
  const out = await printed(child, /^AGENTRUN_BASE_URL=\S+$/m);
  return client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], secrets.AGENTRUN_TOKEN);
}

test("a run's process answers secret(name) for its model's key alone: never the server's token, token list, API key or seal key, nor another provider's or a box's key", { timeout: 120_000 }, async (t) => {
  const api = await launched(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "custody", version: 1, name: "custody", instructions: "Answer.", skills: [], tools: [], model: "openai/gpt-6.1-sol" } })).status, 201);
  const { status, body: run } = await api("POST", "/agents/custody/runs", { input: { content: "Report." } });
  assert.equal(status, 202, JSON.stringify(run));
  let view;
  for (const end = Date.now() + 60_000; (view = (await api("GET", `/runs/${run.run_id}`)).body).status !== "completed"; await sleep(200)) {
    assert.ok(Date.now() < end && view.status !== "failed", `the run did not complete: ${JSON.stringify(view)}`);
  }
  const { handed } = JSON.parse(view.result.final_answer);
  const held = Object.entries(handed).filter(([, digest]) => digest !== "none").map(([name]) => name);
  assert.ok(held.includes("OPENAI_API_KEY"), "the run's process holds its model's key");
  assert.deepEqual(held.filter((name) => SERVER_ONLY.includes(name)), [], "a run's code reads the server's own secrets through secret()");
  assert.deepEqual(held, ["OPENAI_API_KEY"], "a run's process holds its model's key alone");
});
