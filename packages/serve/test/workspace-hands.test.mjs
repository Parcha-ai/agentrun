// The run's hands over its Workspace (serve/src/workspace/hands.ts), as the kernel's tool registry reaches them: a
// command runs by bash -c in the run's folder with the run's fixed environment and nothing of this process's, its
// output decoded per stream as it comes, its end said as an exit code, a signal or a timeout, capped at maxExecS; an
// abort throws; stat, read, write and append are the port's.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { handsOf, localWorkspace, MAX_EXEC_S, shellEnv } from "../dist/workspace/index.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-hands-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

test("the run's shell environment is fixed: PATH, a UTF-8 locale, a dumb terminal, HOME only where given; nothing of this process's", () => {
  const env = shellEnv();
  assert.deepEqual(Object.keys(env).sort(), ["LANG", "LC_ALL", "PATH", "TERM"]);
  assert.match(env.PATH, /^\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.equal(shellEnv({ home: "/x" }).HOME, "/x");
  assert.equal(shellEnv({ tmpdir: "/x/.agentrun/tmp" }).TMPDIR, "/x/.agentrun/tmp");
});

test("hands.exec: bash -c in the run's folder, with only the run's environment; output as it comes, decoded per stream, a character split across chunks whole", async () => {
  const root = scratch();
  writeFileSync(join(root, "here.txt"), "found");
  process.env.AGENTRUN_HANDS_SENTINEL = "a server secret";
  try {
    const hands = handsOf(localWorkspace(root), { maxExecS: MAX_EXEC_S, env: shellEnv({ home: root }) });
    assert.equal(hands.maxExecS, 600);
    const chunks = { stdout: [], stderr: [] };
    // "é" is 2 bytes: printf its first byte, sleep, then its second, so the port gives them in two chunks.
    const ran = await hands.exec("cat here.txt; echo; echo \"[$AGENTRUN_HANDS_SENTINEL]\" \"$HOME\" \"$0\"; printf '\\303'; sleep 0.3; printf '\\251\\n'; echo err >&2; exit 3", { timeoutS: 10, onOutput: ({ stream, data }) => chunks[stream].push(data) });
    assert.deepEqual(ran, { exitCode: 3, signal: null, timedOut: false });
    assert.equal(chunks.stdout.join(""), `found\n[] ${root} bash\né\n`);
    assert.ok(!chunks.stdout.some((chunk) => chunk.includes("�")), "no chunk ends inside a character");
    assert.equal(chunks.stderr.join(""), "err\n");
  } finally {
    delete process.env.AGENTRUN_HANDS_SENTINEL;
  }
});

test("hands.exec: a signal, a timeout capped at maxExecS, and an abort", async () => {
  const root = scratch();
  const hands = handsOf(localWorkspace(root), { maxExecS: 1, env: shellEnv() });
  assert.deepEqual(await hands.exec("kill -TERM $$", { timeoutS: 10 }), { exitCode: null, signal: "TERM", timedOut: false });
  const started = Date.now();
  assert.deepEqual(await hands.exec("sleep 30", { timeoutS: 900 }), { exitCode: null, signal: "KILL", timedOut: true }, "900 s asked, maxExecS 1 s");
  assert.ok(Date.now() - started < 5_000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(handsOf(localWorkspace(root), { maxExecS: 600, env: shellEnv() }).exec("sleep 30", { timeoutS: 60 }, controller.signal), (error) => error?.name === "AbortError");
  await assert.rejects(hands.exec("true", { timeoutS: 0 }), (error) => error?.code === "REFUSED");
});

test("hands: stat, read, write, append and list are the port's; a link is a link, never followed", async () => {
  const root = scratch();
  const hands = handsOf(localWorkspace(root), { maxExecS: MAX_EXEC_S, env: shellEnv() });
  await hands.write("a/b.txt", Buffer.from("one"));
  await hands.append("a/b.txt", Buffer.from("two"));
  assert.equal(Buffer.from(await hands.read("a/b.txt")).toString(), "onetwo");
  assert.equal(Buffer.from(await hands.read("a/b.txt", { offset: 3, length: 2 })).toString(), "tw");
  const stat = await hands.stat("a/b.txt");
  assert.deepEqual([stat.kind, stat.size], ["file", 6]);
  assert.equal((await hands.stat("a")).kind, "dir");
  assert.equal(await hands.stat("nope"), undefined);
  symlinkSync("/etc", join(root, "link"));
  assert.equal((await hands.stat("link")).kind, "link");
  assert.deepEqual(await hands.list(""), [{ name: "a", kind: "dir", size: 0 }]);
  assert.equal(await hands.grep("two", "a"), "a/b.txt:1:onetwo");
});
