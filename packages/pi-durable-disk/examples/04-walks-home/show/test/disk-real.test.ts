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
// @ts-expect-error plain .mjs helper shared with the check scripts
import { startTakeServer } from "../scripts/takeserver.mjs";

// The stage's disk against the REAL 03 server (take-server.mjs: a local directory for a disk, no cloud machines) with a real writer
// attached through the pipe: the tab's files go over the server's work route with the run secret the stage holds.
const show = fileURLToPath(new URL("..", import.meta.url));

describe("the stage's disk on the real 03 server", () => {
  const kids: ChildProcess[] = [];
  let writer: PipeClient;
  let base = "";
  const root = join(homedir(), "tmp-d5", `disk-real-${Date.now().toString(36)}`);

  before(async () => {
    mkdirSync(root, { recursive: true, mode: 0o755 });
    const run = (file: string, args: string[], env: Record<string, string>) => {
      const k = spawn(process.execPath, [join(show, file), ...args], { cwd: show, env: { ...process.env, ...env }, stdio: "ignore" });
      kids.push(k);
      return k;
    };
    mkdirSync(join(root, "disk"), { recursive: true, mode: 0o755 });
    const take = await startTakeServer({ dir: join(root, "take"), disk: join(root, "disk"), cloud: "none" });
    kids.push(take.child);
    const linkFile = take.status.linkFile as string;
    const link = new URL(readFileSync(linkFile, "utf8").trim());
    // A real writer holds the run: a PUT is accepted only from the tab the pipe says holds it.
    writer = new PipeClient({ url: `ws://${link.host}/ws`, run: link.pathname.split("/").at(-1)!, token: link.hash.slice(1), tab: "tab-under-test", mode: "write" });
    await writer.ready;
    const port = await freePort();
    const stage = run("serve.ts", [], { SHOW_PORT: String(port), SHOW_PIPE_LINK_FILE: linkFile, SHOW_ASK_AFTER_SWITCH: "0" });
    await waitForStage(port, stage, 20_000);
    base = `http://127.0.0.1:${port}`;
    // The stage learns who holds the run from the pipe's placement frames; wait for it.
    for (let i = 0; i < 50; i++) {
      if ((await (await fetch(`${base}/api/state`)).json()).place?.where === "tab") break;
      await new Promise((r) => setTimeout(r, 200));
    }
  });
  after(() => {
    writer?.close();
    for (const k of kids) k.kill("SIGTERM");
  });

  const put = (path: string, body: string) => fetch(`${base}/api/disk/${path}`, { method: "PUT", body });

  it("a design save is 200", async () => {
    assert.equal((await put("creature/designs.sqlite", "design bytes")).status, 200);
    assert.equal((await put("creature/body.json", '{"legs":4}')).status, 200);
    assert.equal((await put("creature/creature.xml", "<mujoco/>")).status, 200);
  });

  it("a write to memory.sqlite is 403, in the server's words: the agent writes that file, not the tab", async () => {
    const res = await put("creature/memory.sqlite", "tab must not write this");
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /may not write creature\/memory\.sqlite/);
  });

  it("a path outside the allowlist is 403 too", async () => {
    assert.equal((await put("creature/other.bin", "x")).status, 403);
  });

  it("what was saved reads back as the same bytes with an etag, and a read with that etag is 304 with no body", async () => {
    const res = await fetch(`${base}/api/disk/creature/designs.sqlite`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "design bytes");
    const etag = res.headers.get("etag")!;
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    const again = await fetch(`${base}/api/disk/creature/designs.sqlite`, { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
    await put("creature/designs.sqlite", "a changed design");
    const changed = await fetch(`${base}/api/disk/creature/designs.sqlite`, { headers: { "if-none-match": etag } });
    assert.equal(changed.status, 200);
    assert.equal(await changed.text(), "a changed design");
  });

  it("a file that is not there yet is 204, and the run's secret is nowhere in what the stage sends", async () => {
    const missing = await fetch(`${base}/api/disk/creature/memory.sqlite`);
    assert.equal(missing.status, 204);
    const link = readFileSync(join(root, "take", "link"), "utf8").trim();
    const secret = new URL(link).hash.slice(1);
    for (const path of ["/api/state", "/api/disk/creature/designs.sqlite"]) {
      const res = await fetch(`${base}${path}`);
      assert.ok(!(await res.text()).includes(secret) && !JSON.stringify([...res.headers]).includes(secret), path);
    }
  });

  it("when no tab holds the run a write is 409, not lost", async () => {
    writer.close();
    for (let i = 0; i < 40; i++) {
      const s = await (await fetch(`${base}/api/state`)).json();
      if (s.place?.where !== "tab") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const res = await put("creature/designs.sqlite", "x");
    assert.equal(res.status, 409);
  });
});
