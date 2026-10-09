import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PipeClient } from "../../../03-tab-to-cloud/tab/pipe-client.ts";
// @ts-expect-error plain .mjs helpers shared with the check scripts
import { freePort, waitForStage } from "../scripts/cdp.mjs";
// @ts-expect-error plain .mjs helper
import { startTakeServer } from "../scripts/takeserver.mjs";

// A retake: the take server is stopped and started again (a new run, a new port, a new secret) and rewrites the link file. The stage
// must follow without being restarted: its feed, its pages and its disk all move to the new run.
const show = fileURLToPath(new URL("..", import.meta.url));

describe("the stage follows the run link when the server is restarted", () => {
  const root = join(homedir(), "tmp-d5", `live-link-${Date.now().toString(36)}`);
  const dir = join(root, "take");
  const kids: ChildProcess[] = [];
  const writers: PipeClient[] = [];
  let stage: ChildProcess;
  let base = "";
  let first: { child: ChildProcess; status: { origin: string; linkFile: string } };

  const attachWriter = async (linkFile: string, tab: string) => {
    const link = new URL(readFileSync(linkFile, "utf8").trim());
    const w = new PipeClient({ url: `ws://${link.host}/ws`, run: link.pathname.split("/").at(-1)!, token: link.hash.slice(1), tab, mode: "write" });
    await w.ready;
    writers.push(w);
  };
  const state = async () => (await fetch(`${base}/api/state`)).json() as Promise<{ run: string; place?: { where: string }; environments: unknown[] }>;
  const until = async (check: () => Promise<boolean>, ms = 20_000) => {
    for (let t = 0; t < ms; t += 200) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail("timed out");
  };

  before(async () => {
    mkdirSync(join(root, "disk"), { recursive: true, mode: 0o755 });
    first = await startTakeServer({ dir, disk: join(root, "disk"), cloud: "none", run: "run-one" });
    kids.push(first.child);
    await attachWriter(first.status.linkFile, "tab-one");
    const port = await freePort();
    stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_PIPE_LINK_FILE: first.status.linkFile, SHOW_ASK_AFTER_SWITCH: "0" }, stdio: "ignore" });
    kids.push(stage);
    await waitForStage(port, stage, 20_000);
    base = `http://127.0.0.1:${port}`;
    await until(async () => (await state()).run === "run-one" && (await state()).place?.where === "tab");
  });
  after(() => {
    for (const w of writers) w.close();
    for (const k of kids) k.kill("SIGTERM");
  });

  it("follows the link file to a new run, tells connected pages to reload, and writes to the new run's disk", async () => {
    // A page connected before the restart.
    const sse = await fetch(`${base}/api/events`);
    const reader = sse.body!.getReader();
    let seen = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        seen += new TextDecoder().decode(value);
      }
    })();

    assert.equal((await fetch(`${base}/api/disk/creature/designs.sqlite`, { method: "PUT", body: "run one" })).status, 200);
    // The retake: stop the server, start another on the same private directory (it rewrites the link file).
    first.child.kill("SIGTERM");
    await new Promise((r) => first.child.once("exit", r));
    const second = await startTakeServer({ dir, disk: join(root, "disk2"), cloud: "none", run: "run-two" });
    kids.push(second.child);
    assert.notEqual(second.status.origin, first.status.origin, "another port");
    await attachWriter(second.status.linkFile, "tab-two");

    await until(async () => (await state()).run === "run-two" && (await state()).place?.where === "tab");
    assert.match(seen, /event: reset/, "the connected page was told to fetch the new snapshot");
    // The disk follows too: a write goes to run two with run two's secret (run one's secret would be a 404 there).
    assert.equal((await fetch(`${base}/api/disk/creature/designs.sqlite`, { method: "PUT", body: "run two" })).status, 200);
    const back = await fetch(`${base}/api/disk/creature/designs.sqlite`);
    assert.equal(await back.text(), "run two");
    await reader.cancel();
    await pump.catch(() => undefined);
  });

  it("the run's secret is not in anything the stage sends, before or after the restart", async () => {
    const link = readFileSync(join(dir, "link"), "utf8").trim();
    const secret = new URL(link).hash.slice(1);
    for (const path of ["/api/state", "/api/disk/creature/designs.sqlite"]) {
      const res = await fetch(`${base}${path}`);
      assert.ok(!(await res.text()).includes(secret) && !JSON.stringify([...res.headers]).includes(secret), path);
    }
  });
});
