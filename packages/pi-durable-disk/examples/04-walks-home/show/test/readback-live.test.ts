import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PipeClient } from "../../../03-tab-to-cloud/tab/pipe-client.ts";
// @ts-expect-error plain .mjs helpers shared with the check scripts
import { freePort, waitForStage } from "../scripts/cdp.mjs";
// @ts-expect-error plain .mjs helper
import { startTakeServer } from "../scripts/takeserver.mjs";

// The stage reads the take server's real log for its read-back lines (SHOW_TAKE_STATUS names the status file). The take server here has
// no object store (--local), so it never writes a read-back itself: the lines it would write are appended to its real log file, which
// also holds the run's link. The adapter boundary is the log file; everything from the file to the page's state is the real code.
const show = fileURLToPath(new URL("..", import.meta.url));

describe("the stage turns the take server's read-back lines into notes", () => {
  const root = join(homedir(), "tmp-d5", `readback-live-${Date.now().toString(36)}`);
  const dir = join(root, "take");
  const kids: ChildProcess[] = [];
  let writer: PipeClient;
  let base = "";
  let logFile = "";
  let secret = "";

  type Note = { kind: string; text: string; measured?: boolean; evidence?: string };
  const notes = async () => ((await (await fetch(`${base}/api/state`)).json()) as { notes: Note[] }).notes;
  const until = async (check: () => Promise<boolean>, ms = 20_000) => {
    for (let t = 0; t < ms; t += 200) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail("timed out");
  };
  const logLine = (event: string, data: Record<string, unknown>) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);

  before(async () => {
    mkdirSync(join(root, "disk"), { recursive: true, mode: 0o755 });
    const take = await startTakeServer({ dir, disk: join(root, "disk"), cloud: "none", run: "rb-run" });
    kids.push(take.child);
    logFile = take.status.logFile;
    const link = new URL(readFileSync(take.status.linkFile, "utf8").trim());
    secret = link.hash.slice(1);
    writer = new PipeClient({ url: `ws://${link.host}/ws`, run: "rb-run", token: secret, tab: "tab-rb", mode: "write" });
    await writer.ready;
    const port = await freePort();
    const stage = spawn(process.execPath, [join(show, "serve.ts")], {
      cwd: show,
      env: { ...process.env, SHOW_PORT: String(port), SHOW_PIPE_LINK_FILE: take.status.linkFile, SHOW_TAKE_STATUS: join(dir, "status.json"), SHOW_ASK_AFTER_SWITCH: "0" },
      stdio: "ignore",
    });
    kids.push(stage);
    await waitForStage(port, stage, 20_000);
    base = `http://127.0.0.1:${port}`;
    await until(async () => ((await (await fetch(`${base}/api/state`)).json()) as { run: string }).run === "rb-run");
  });
  after(() => {
    writer?.close();
    for (const k of kids) k.kill("SIGTERM");
  });

  it("a verified read-back becomes a note with independent-readback evidence; the others carry none, and nothing else from the log appears", async () => {
    logLine("pipe.readback", { run: "other-run", files: 99, bytes: 1, ms: 1, match: true, ackedMatch: true });
    logLine("pipe.readback", { run: "rb-run", generation: 2, startedAfterMs: 90, ms: 210, files: 5, bytes: 4096, digest: "d".repeat(64), kept: "d".repeat(64), acked: "d".repeat(64), match: true, ackedMatch: true });
    logLine("pipe.readback", { run: "rb-run", generation: 3, startedAfterMs: 90, ms: 180, files: 6, bytes: 8192, digest: "e".repeat(64), kept: "d".repeat(64), acked: null, match: false, ackedMatch: null });
    await until(async () => (await notes()).filter((n) => /Read back/.test(n.text)).length >= 2);
    const read = (await notes()).filter((n) => /Read back/.test(n.text));
    assert.equal(read.length, 2, "the other run's line is ignored");
    assert.deepEqual([read[0]!.evidence, read[0]!.measured], ["independent-readback", true]);
    assert.match(read[0]!.text, /5 files, 4\.0 KB, identical to what the tab had acknowledged and to what the pipe sealed/);
    assert.deepEqual([read[1]!.evidence, read[1]!.measured], [undefined, true]);
    assert.match(read[1]!.text, /DIFFERS from what the pipe sealed/);
    const everything = JSON.stringify(await (await fetch(`${base}/api/state`)).json());
    assert.ok(!everything.includes(secret) && !everything.includes("d".repeat(64)), "neither the run's secret nor a digest reaches a page");
  });
});
