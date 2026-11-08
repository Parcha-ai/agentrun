// The Workspace conformance suite: what every backend answers the same way. A backend's test file calls
// `suite(name, make)`; `make()` gives a fresh, empty workspace and the local folders behind it:
//   { workspace, root, outside }
// `root` is the folder that holds what the workspace sees (for a backend over a fake, the fake's own folder), so the
// suite can plant a symbolic link in it; `outside` is a folder beside it, which holds a sentinel no call may touch.
// The cases use only the Workspace interface, apart from planting links and reading the sentinel.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, test } from "node:test";

/** The PATH every exec here is given: nothing is inherited. */
export const PATH = "/usr/local/bin:/usr/bin:/bin";
const ENV = { PATH };
const SENTINEL = "the sentinel, outside the root\n";

/** Rejects with a WorkspaceError of `code`. */
async function refused(promise, code, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "WorkspaceError", `${label}: a WorkspaceError, not ${error?.stack ?? error}`);
    assert.equal(error.code, code, `${label}: ${code}, not ${error.code} (${error.message})`);
    return true;
  });
}

const text = (bytes) => Buffer.from(bytes).toString("utf8");

export function suite(name, make) {
  /** A fresh workspace, with a sentinel file outside its root. */
  async function fresh() {
    const made = await make();
    writeFileSync(join(made.outside, "sentinel"), SENTINEL);
    return made;
  }
  /** The folder outside the root holds the sentinel, unchanged, and nothing else. */
  function untouched(outside) {
    assert.deepEqual(readdirSync(outside), ["sentinel"], "nothing was made outside the root");
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), SENTINEL, "the sentinel outside the root is unchanged");
  }

  describe(`workspace conformance: ${name}`, () => {
    test("write then read gives the same bytes, binary included; a string is UTF-8; a write replaces", async () => {
      const { workspace } = await fresh();
      const every = Uint8Array.from({ length: 256 }, (_, i) => i);
      const big = randomBytes(3 * 1024 * 1024 + 7);
      await workspace.write("bytes.bin", every);
      await workspace.write("deep/er/big.bin", big);
      await workspace.write("hello.txt", "héllo\n");
      assert.deepEqual(Buffer.from(await workspace.read("bytes.bin")), Buffer.from(every));
      assert.ok(Buffer.from(await workspace.read("deep/er/big.bin")).equals(big), "a big binary file reads back whole");
      assert.equal(text(await workspace.read("hello.txt")), "héllo\n");
      await workspace.write("hello.txt", "bye");
      assert.equal(text(await workspace.read("hello.txt")), "bye", "a write replaces the whole file");
      await workspace.write("empty", new Uint8Array(0));
      assert.equal((await workspace.read("empty")).length, 0);
      assert.deepEqual((await workspace.list("")).map((e) => e.name), ["bytes.bin", "deep", "empty", "hello.txt"], "a write leaves no temporary file");
    });

    test("read with offset and length gives the slice; past the end gives what is there", async () => {
      const { workspace } = await fresh();
      await workspace.write("abc", "0123456789");
      assert.equal(text(await workspace.read("abc", { offset: 3, length: 4 })), "3456");
      assert.equal(text(await workspace.read("abc", { offset: 7 })), "789");
      assert.equal(text(await workspace.read("abc", { length: 2 })), "01");
      assert.equal(text(await workspace.read("abc", { offset: 8, length: 100 })), "89");
      assert.equal((await workspace.read("abc", { offset: 50 })).length, 0);
    });

    test("append grows a file, and makes it and its parents when absent", async () => {
      const { workspace } = await fresh();
      await workspace.append("logs/a/run.log", "one\n");
      await workspace.append("logs/a/run.log", Uint8Array.from([0x74, 0x77, 0x6f, 0x0a]));
      await workspace.append("logs/a/run.log", "three\n");
      assert.equal(text(await workspace.read("logs/a/run.log")), "one\ntwo\nthree\n");
    });

    test("list sorts by name, with kinds and sizes; the root is \"\" or \".\"", async () => {
      const { workspace } = await fresh();
      await workspace.write("b.txt", "12345");
      await workspace.write("a/x", "1");
      await workspace.write("C", "");
      await workspace.mkdir("z/y");
      const listed = await workspace.list("");
      assert.deepEqual(listed.map(({ name, kind }) => ({ name, kind })), [
        { name: "C", kind: "file" }, { name: "a", kind: "dir" }, { name: "b.txt", kind: "file" }, { name: "z", kind: "dir" },
      ]);
      assert.equal(listed.find((e) => e.name === "b.txt").size, 5);
      assert.deepEqual(await workspace.list("."), listed);
      assert.deepEqual((await workspace.list("z")).map((e) => [e.name, e.kind]), [["y", "dir"]]);
      assert.deepEqual(await workspace.list("z/y"), []);
    });

    test("list gives each entry's last change (modifiedMs, ms since the epoch): a later write moves it on", async () => {
      const { workspace } = await fresh();
      // A backend's clock (a disk's servers) may be a little off this machine's: two seconds either way.
      const before = Date.now() - 2000;
      await workspace.write("a.txt", "one");
      await workspace.mkdir("d");
      const first = await workspace.list("");
      for (const entry of first) {
        assert.ok(Number.isFinite(entry.modifiedMs), `${entry.name}: a number, not ${entry.modifiedMs}`);
        assert.ok(entry.modifiedMs >= before && entry.modifiedMs <= Date.now() + 2000, `${entry.name}: ${new Date(entry.modifiedMs).toISOString()} is about now`);
        assert.equal(entry.unreadable, undefined, `${entry.name}: a file the workspace wrote reads`);
      }
      await sleep(1100);
      await workspace.write("a.txt", "two");
      const again = (await workspace.list("")).find((e) => e.name === "a.txt");
      assert.ok(again.modifiedMs > first.find((e) => e.name === "a.txt").modifiedMs, "a write moves the file's time on");
    });

    test("mkdir makes a directory and its parents; one already there is fine; a file in the way is EXISTS", async () => {
      const { workspace } = await fresh();
      await workspace.mkdir("p/q/r");
      await workspace.mkdir("p/q/r");
      await workspace.mkdir("p");
      assert.deepEqual((await workspace.list("p/q")).map((e) => e.name), ["r"]);
      await workspace.write("p/file", "x");
      await refused(workspace.mkdir("p/file"), "EXISTS", "mkdir over a file");
      await refused(workspace.mkdir("p/file/under"), "EXISTS", "mkdir under a file");
      await refused(workspace.write("p/file/under", "x"), "EXISTS", "a write under a file");
    });

    test("grep finds lines, honours max, path and glob, and skips binary files", async () => {
      const { workspace } = await fresh();
      await workspace.write("notes/a.md", "alpha\nneedle one\ngamma\n");
      await workspace.write("notes/b.txt", "needle two\nneedle three");
      await workspace.write("src/c.ts", "const needle = 4;\n");
      await workspace.write("blob.bin", Buffer.concat([Buffer.from("needle in a binary\n"), Buffer.from([0, 1, 2, 0])]));
      const all = await workspace.grep("needle");
      assert.equal(all.truncated, false);
      assert.deepEqual(all.matches, [
        { path: "notes/a.md", line: 2, text: "needle one" },
        { path: "notes/b.txt", line: 1, text: "needle two" },
        { path: "notes/b.txt", line: 2, text: "needle three" },
        { path: "src/c.ts", line: 1, text: "const needle = 4;" },
      ], "every match, in path order, and none from the binary file");
      const started = Date.now();
      await workspace.write("evil.txt", `aaa\n${"a".repeat(64)}!\n`);
      const evil = await workspace.grep("^(a+)+$", { timeMs: 500 });
      assert.equal(evil.truncated, "time", "a regex that backtracks without end is stopped at the deadline");
      assert.deepEqual(evil.matches, [{ path: "evil.txt", line: 1, text: "aaa" }], "what it found before the deadline, in the same file, is returned");
      assert.ok(Date.now() - started < 5_000, `it returned at the deadline, not ${Date.now() - started} ms later`);
      await workspace.remove("evil.txt");
      const two = await workspace.grep("needle", { max: 2 });
      assert.equal(two.matches.length, 2);
      assert.equal(two.truncated, "max");
      assert.deepEqual((await workspace.grep("needle", { path: "notes" })).matches.map((m) => m.path), ["notes/a.md", "notes/b.txt", "notes/b.txt"]);
      assert.deepEqual((await workspace.grep("needle", { path: "src/c.ts" })).matches.map((m) => m.path), ["src/c.ts"]);
      assert.deepEqual((await workspace.grep("needle", { glob: "*.md" })).matches.map((m) => m.path), ["notes/a.md"]);
      assert.deepEqual((await workspace.grep("needle", { glob: "src/**" })).matches.map((m) => m.path), ["src/c.ts"]);
      assert.deepEqual((await workspace.grep("^needle t[wh]")).matches.map((m) => m.text), ["needle two", "needle three"], "the pattern is a regex");
      assert.deepEqual((await workspace.grep("absent")).matches, []);
      await refused(workspace.grep("("), "REFUSED", "a bad regex");
      await refused(workspace.grep("x", { path: "nope" }), "NOT_FOUND", "grep under a missing path");
    });

    test("remove takes a file, an empty directory, and with recursive a tree; the root is never removed", async () => {
      const { workspace } = await fresh();
      await workspace.write("f", "x");
      await workspace.mkdir("empty");
      await workspace.write("tree/a/b/c", "x");
      await workspace.write("tree/d", "x");
      await workspace.remove("f");
      await workspace.remove("empty");
      await refused(workspace.remove("tree"), "REFUSED", "a directory that is not empty, without recursive");
      await workspace.remove("tree", { recursive: true });
      assert.deepEqual(await workspace.list(""), []);
      await refused(workspace.read("f"), "NOT_FOUND", "a removed file");
      await refused(workspace.remove("f"), "NOT_FOUND", "removing what is not there");
      await workspace.remove("f", { force: true });
      await refused(workspace.remove(""), "REFUSED", "removing the root");
      await refused(workspace.remove(".", { recursive: true, force: true }), "REFUSED", "removing the root");
    });

    test("a path that is not there is NOT_FOUND", async () => {
      const { workspace } = await fresh();
      await refused(workspace.read("missing"), "NOT_FOUND", "read");
      await refused(workspace.read("no/such/dir/file"), "NOT_FOUND", "read under missing directories");
      await refused(workspace.list("missing"), "NOT_FOUND", "list");
      await refused(workspace.remove("missing/x"), "NOT_FOUND", "remove");
      await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 5_000, cwd: "missing" }), "NOT_FOUND", "exec in a missing directory");
      await refused(workspace.exec(["no-such-program-anywhere"], { env: ENV, timeoutMs: 5_000 }), "NOT_FOUND", "exec of a missing program");
    });

    test("a path that leaves the root is ESCAPE, for every call, and nothing outside is touched", async () => {
      const { workspace, outside } = await fresh();
      await workspace.mkdir("a");
      const bad = ["../x", "/etc/passwd", "a/../../x", "../outside/sentinel", "a/..", "./a", "a//b", "a/", "a\\..\\..\\x", "a\0b", "..", "/"];
      for (const path of bad) {
        await refused(workspace.read(path), "ESCAPE", `read ${JSON.stringify(path)}`);
        await refused(workspace.write(path, "x"), "ESCAPE", `write ${JSON.stringify(path)}`);
        await refused(workspace.append(path, "x"), "ESCAPE", `append ${JSON.stringify(path)}`);
        await refused(workspace.list(path), "ESCAPE", `list ${JSON.stringify(path)}`);
        await refused(workspace.mkdir(path), "ESCAPE", `mkdir ${JSON.stringify(path)}`);
        await refused(workspace.remove(path, { recursive: true, force: true }), "ESCAPE", `remove ${JSON.stringify(path)}`);
        await refused(workspace.grep("x", { path }), "ESCAPE", `grep in ${JSON.stringify(path)}`);
        await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 5_000, cwd: path }), "ESCAPE", `exec in ${JSON.stringify(path)}`);
      }
      untouched(outside);
    });

    test("a symbolic link in the root that points outside is ESCAPE: for a read, a write, exec's cwd, and as the last part", async () => {
      const { workspace, root, outside } = await fresh();
      symlinkSync(outside, join(root, "dirlink"));
      symlinkSync(join(outside, "sentinel"), join(root, "filelink"));
      await workspace.mkdir("sub");
      symlinkSync("../dirlink", join(root, "sub", "hop"));
      for (const path of ["dirlink/sentinel", "filelink", "sub/hop/sentinel"]) {
        await refused(workspace.read(path), "ESCAPE", `read ${path}`);
        await refused(workspace.write(path, "overwritten"), "ESCAPE", `write ${path}`);
        await refused(workspace.append(path, "appended"), "ESCAPE", `append ${path}`);
        await refused(workspace.remove(path, { force: true }), "ESCAPE", `remove ${path}`);
      }
      for (const path of ["dirlink/new", "dirlink/new/deeper", "sub/hop/new"]) {
        await refused(workspace.write(path, "x"), "ESCAPE", `write ${path}`);
        await refused(workspace.mkdir(path), "ESCAPE", `mkdir ${path}`);
      }
      for (const path of ["dirlink", "sub/hop"]) {
        await refused(workspace.list(path), "ESCAPE", `list ${path}`);
        await refused(workspace.grep("sentinel", { path }), "ESCAPE", `grep in ${path}`);
        await refused(workspace.exec(["bash", "-c", "echo pwned > pwned"], { env: ENV, timeoutMs: 5_000, cwd: path }), "ESCAPE", `exec in ${path}`);
      }
      assert.deepEqual((await workspace.grep("sentinel")).matches, [], "grep of the root follows no link");
      await workspace.remove("sub", { recursive: true });
      assert.equal(existsSync(join(root, "sub")), false, "a recursive remove takes the link inside, never what it points at");
      untouched(outside);
    });

    test("a write is atomic: a reader never sees half a file", async () => {
      const { workspace } = await fresh();
      const size = 4 * 1024 * 1024;
      const versions = ["a", "b", "c", "d"].map((c) => Buffer.alloc(size, c));
      await workspace.write("big", versions[0]);
      let writing = true;
      const seen = new Set();
      const reader = (async () => {
        while (writing) {
          const got = Buffer.from(await workspace.read("big"));
          assert.equal(got.length, size, "a read sees a whole file");
          assert.ok(got.every((b) => b === got[0]), "a read sees one version, never a mix");
          seen.add(String.fromCharCode(got[0]));
        }
      })();
      for (let i = 1; i <= 12; i++) await workspace.write("big", versions[i % versions.length]);
      writing = false;
      await reader;
      assert.ok(seen.size >= 1);
    });

    test("exec: binary stdin to stdout, and the env is exactly what is given", async () => {
      const { workspace } = await fresh();
      const bytes = Buffer.concat([Uint8Array.from({ length: 256 }, (_, i) => i), randomBytes(200_000)]);
      const cat = await workspace.exec(["cat"], { env: ENV, stdin: bytes, timeoutMs: 10_000 });
      assert.equal(cat.code, 0);
      assert.equal(cat.timedOut, false);
      assert.equal(cat.truncated, false);
      assert.ok(Buffer.from(cat.stdout).equals(bytes), "stdin comes back on stdout byte for byte");
      const env = await workspace.exec(["env"], { env: { PATH, ONLY: "this one" }, timeoutMs: 10_000 });
      assert.deepEqual(text(env.stdout).trim().split("\n").sort(), ["ONLY=this one", `PATH=${PATH}`], "only the given variables: no HOME");
      const err = await workspace.exec(["bash", "-c", "echo out; echo err >&2; exit 3"], { env: ENV, timeoutMs: 10_000 });
      assert.deepEqual([text(err.stdout), err.stderr, err.code, err.timedOut], ["out\n", "err\n", 3, false], "a nonzero code is a result");
    });

    test("exec: the cwd is honoured, under the root", async () => {
      const { workspace } = await fresh();
      await workspace.write("sub/dir/marker", "found it");
      await workspace.write("top", "root");
      assert.equal(text((await workspace.exec(["cat", "marker"], { env: ENV, cwd: "sub/dir", timeoutMs: 10_000 })).stdout), "found it");
      assert.equal(text((await workspace.exec(["cat", "top"], { env: ENV, timeoutMs: 10_000 })).stdout), "root", "the root by default");
      await workspace.exec(["bash", "-c", "printf made > made-here"], { env: ENV, cwd: "sub", timeoutMs: 10_000 });
      assert.equal(text(await workspace.read("sub/made-here")), "made");
    });

    test("exec: the deadline kills the child and its grandchild; nothing it started outlives it", async () => {
      const { workspace } = await fresh();
      const started = Date.now();
      const slow = await workspace.exec(["bash", "-c", "(sleep 1.5; echo alive > late) & sleep 30"], { env: ENV, timeoutMs: 500 });
      assert.equal(slow.timedOut, true);
      assert.equal(slow.code, null);
      assert.ok(Date.now() - started < 5_000, "it returns at the deadline, not when the sleep would end");
      const quick = await workspace.exec(["bash", "-c", "(sleep 1.5; echo alive > left) & echo done"], { env: ENV, timeoutMs: 10_000 });
      assert.deepEqual([text(quick.stdout), quick.code, quick.timedOut], ["done\n", 0, false]);
      await sleep(2_500);
      await refused(workspace.read("late"), "NOT_FOUND", "the grandchild of a timed-out exec was killed");
      await refused(workspace.read("left"), "NOT_FOUND", "the grandchild of an exec that exited was killed");
    });

    test("exec: output past the cap is cut and flagged", async () => {
      const { workspace } = await fresh();
      const out = await workspace.exec(["head", "-c", "300000", "/dev/zero"], { env: ENV, maxOutput: 1000, timeoutMs: 10_000 });
      assert.equal(out.stdout.length, 1000);
      assert.equal(out.truncated, true);
      assert.equal(out.code, 0, "the child is not killed for it");
      const err = await workspace.exec(["bash", "-c", "head -c 5000 /dev/zero | tr '\\0' e >&2"], { env: ENV, maxOutput: 100, timeoutMs: 10_000 });
      assert.equal(err.stderr, "e".repeat(100));
      assert.equal(err.truncated, true);
    });

    test("exec: onOutput gets the output, joined per stream it is the result's (capped), and it comes as it is made", async () => {
      const { workspace } = await fresh();
      const seen = { stdout: [], stderr: [] };
      let firstAt;
      const started = Date.now();
      const script = "printf one; sleep 1; printf two; printf err >&2; head -c 5000 /dev/zero";
      const out = await workspace.exec(["bash", "-c", script], { env: ENV, maxOutput: 1000, timeoutMs: 10_000, onOutput: ({ stream, data }) => {
        firstAt ??= Date.now() - started;
        seen[stream].push(Buffer.from(data));
      } });
      assert.ok(Buffer.concat(seen.stdout).equals(Buffer.from(out.stdout)), "stdout's pieces join to the result's stdout");
      assert.equal(Buffer.concat(seen.stderr).toString("utf8"), out.stderr, "stderr's pieces join to the result's stderr");
      assert.equal(out.stdout.length, 1000, "both are cut at the cap");
      assert.equal(Buffer.from(out.stdout).subarray(0, 6).toString(), "onetwo");
      // A backend that streams gives the first piece before the program ends; one that cannot gives each stream once.
      const streams = seen.stdout.length > 1 || seen.stderr.length > 1;
      if (streams) assert.ok(firstAt < 900, `the first piece came as it was made (${firstAt} ms)`);
      else assert.deepEqual([seen.stdout.length, seen.stderr.length], [1, 1], "a backend that cannot stream calls it once per stream");
    });

    test("with no computer, every background call is REFUSED, cause no-computer", async () => {
      const { workspace } = await fresh();
      for (const call of ["start", "read", "write", "signal", "wait", "list"]) {
        await refused(workspace.process[call]({ id: "p1", argv: ["sleep", "1"] }), "REFUSED", `process.${call}`);
        await assert.rejects(workspace.process[call]({ id: "p1" }), (error) => error.cause === "no-computer", `process.${call}: cause no-computer`);
      }
    });
  });
}
