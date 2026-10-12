import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs helper shared with the check scripts: a port the OS says is free
import { freePort } from "../scripts/cdp.mjs";

// The judge route on the real server, in every configuration. The scripted judge approves, so it must exist only when the stage IS the episode 2 rehearsal:
// SHOW_SCENARIO=ep2 and no link file configured at all. A link file that is configured but missing or unreadable is a live take whose run is not up, and it
// must refuse, not approve.
const serve = fileURLToPath(new URL("../serve.ts", import.meta.url));

describe("POST /api/judge on the server", () => {
  const children: ChildProcess[] = [];
  let dir = "";
  afterEach(() => {
    for (const c of children.splice(0)) c.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  async function judge(env: Record<string, string | undefined>): Promise<{ status: number; body: { verdict?: string; scripted?: boolean } }> {
    const port = await freePort();
    const child = spawn(process.execPath, [serve], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SHOW_PORT: String(port), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) }, stdio: "ignore" });
    children.push(child);
    for (let i = 0; i < 100; i++) {
      if (await fetch(`http://127.0.0.1:${port}/api/stage`).then((r) => r.status > 0).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/judge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Who are you?", answer: "I am the Golden Gate Bridge." }) });
    return { status: res.status, body: (await res.json()) as { verdict?: string } };
  }

  it("the ep2 rehearsal, with no link file configured, has the scripted judge", async () => {
    const r = await judge({ SHOW_SCENARIO: "ep2" });
    assert.deepEqual([r.status, r.body.verdict, r.body.scripted], [200, "show", true]);
  });

  it("a link file that is configured but missing refuses a clean answer, even with the rehearsal scenario set", async () => {
    dir = mkdtempSync(join(tmpdir(), "ep2-judge-"));
    const r = await judge({ SHOW_SCENARIO: "ep2", SHOW_PIPE_LINK_FILE: join(dir, "no-such-link") });
    assert.deepEqual([r.status, r.body.verdict], [503, "refuse"]);
  });

  it("a link file that is configured but is not a run link refuses a clean answer", async () => {
    dir = mkdtempSync(join(tmpdir(), "ep2-judge-"));
    const link = join(dir, "link");
    writeFileSync(link, "not a link\n");
    const r = await judge({ SHOW_SCENARIO: "ep2", SHOW_PIPE_LINK_FILE: link });
    assert.deepEqual([r.status, r.body.verdict], [503, "refuse"]);
  });

  it("any stage that is not the ep2 rehearsal refuses a clean answer", async () => {
    for (const env of [{}, { SHOW_SCENARIO: "v2" }, { SHOW_SCENARIO: "EP2" }]) {
      const r = await judge(env);
      assert.deepEqual([r.status, r.body.verdict], [503, "refuse"], JSON.stringify(env));
    }
  });
});
