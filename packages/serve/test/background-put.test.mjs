// A display copy's temporary file is named with four random bytes (od on /dev/urandom). Where they cannot be read (od
// missing or failing, no /dev/urandom), the name would be the same every time for a shell, and a FIFO planted at it hangs
// the copy's exclusive open: the copy is skipped instead, at once, and the process starts and runs as before. The box
// here is this machine's own environment with a search path whose `od` fails, after planting a FIFO at each name the
// copy could fall back to (`.put.<pid>.` for the copy's shell and each of its parents).
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { backgroundTools } from "../dist/background.js";

test("with no random bytes to name a temporary file, a display copy is skipped at once, never hung on a FIFO planted at the name it would fall back to", { timeout: 90_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bg-put-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  await Promise.all([bin, work, join(dir, "tmp")].map((d) => mkdir(d)));
  for (const from of ["/usr/bin", "/bin"]) {
    for (const name of readdirSync(from)) if (name !== "od" && !existsSync(join(bin, name))) symlinkSync(join(from, name), join(bin, name));
  }
  // An od that reads nothing and fails, having planted a FIFO at `.put.<pid>.` for itself and each parent, in the
  // directory the copy runs in.
  writeFileSync(join(bin, "od"), [
    "#!/bin/sh",
    'p=$$; while [ -n "$p" ] && [ "$p" -gt 1 ]; do mkfifo "./.put.$p." 2>/dev/null; p=$(awk \'{ print $4 }\' "/proc/$p/stat" 2>/dev/null); done',
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  const local = new NodeExecutionEnv({ cwd: work });
  const env = { cwd: work, exec: (command, options, context) => local.exec(command, { ...options, env: { PATH: bin, TMPDIR: join(dir, "tmp") }, inheritEnv: false }, context) };
  const [start, , , signal, list] = backgroundTools();
  const began = Date.now();
  const hung = new Promise((_, reject) => setTimeout(() => reject(new Error("the start hung past 12 s on a planted FIFO")), 12_000));
  const started = await Promise.race([start.execute({ command: "sleep 30" }, { env }, ctx), hung]);
  assert.match(started.content[0].text, /^Started background process 1 /);
  assert.ok(Date.now() - began < 12_000);
  // No copy was written: what stands at the names the copy would use is what was planted, and no command or started.
  const names = readdirSync(join(work, "background", "1"));
  assert.ok(!names.includes("command") && !names.includes("started"), JSON.stringify(names));
  assert.ok(names.filter((name) => name.startsWith(".put.")).every((name) => lstatSync(join(work, "background", "1", name)).isFIFO()), JSON.stringify(names));
  // What the tools trust is untouched: the list shows the process's own command, and a signal reaches it.
  assert.match((await list.execute({}, { env }, ctx)).content[0].text, /\n1: is running; .*"sleep 30"$/);
  assert.match((await signal.execute({ id: "1", signal: "KILL" }, { env }, ctx)).content[0].text, /ended by signal KILL/);
});
