// A box with no `script` (util-linux) refuses tty: true in plain words before it starts anything; without tty the same
// box starts the command. The box here is this machine's own environment with a search path that lacks `script`.
import assert from "node:assert/strict";
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { backgroundTools } from "../dist/background.js";

test("a box with no script refuses tty: true in plain words, and makes nothing; without tty it starts", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bg-tty-box-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Every program of /usr/bin and /bin but script.
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  await Promise.all([bin, work, join(dir, "tmp")].map((d) => import("node:fs/promises").then((fs) => fs.mkdir(d))));
  for (const from of ["/usr/bin", "/bin"]) {
    for (const name of readdirSync(from)) if (name !== "script" && !existsSync(join(bin, name))) symlinkSync(join(from, name), join(bin, name));
  }
  const local = new NodeExecutionEnv({ cwd: work });
  const env = { cwd: work, exec: (command, options, context) => local.exec(command, { ...options, env: { PATH: bin, TMPDIR: join(dir, "tmp") }, inheritEnv: false }, context) };
  const [start, output, , signal] = backgroundTools();
  await assert.rejects(start.execute({ command: "tty", tty: true }, { env }, ctx), /this box has no `script` program \(util-linux\), so tty: true cannot run here: start the command without tty/);
  assert.deepEqual(existsSync(join(work, "background")) ? readdirSync(join(work, "background")) : [], [], "the refused start made nothing");
  const started = await start.execute({ command: "echo plain; sleep 30" }, { env }, ctx);
  assert.match(started.content[0].text, /^Started background process 1 /);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match((await output.execute({ id: "1" }, { env }, ctx)).content[0].text, /\n\nplain\n$/);
  assert.match((await signal.execute({ id: "1", signal: "KILL" }, { env }, ctx)).content[0].text, /ended by signal KILL/);
});
