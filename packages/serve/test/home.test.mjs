// An agent's home: a directory of its own under the data directory, kept across its runs, its files listed, read,
// written and deleted through /v2/agents/{id}/home/files. Never through a link, never outside the home, and never into a
// path only the server writes (learning/).
import assert from "node:assert/strict";
import { existsSync, readlinkSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { confineTestHooks as confineHooks } from "@parcha/pi-durable-disk/internals";
import { homeKey, homeOf } from "../dist/files.js";
import { workspaceTestHooks } from "../dist/workspace.js";
import { agent, serve } from "./support.mjs";

/** A server with the agent `keeper`, and where its home is on disk. */
async function served(t) {
  const server = await serve(t);
  assert.equal((await server.api("POST", "/agents", agent("keeper"))).status, 201);
  return { ...server, home: homeOf(server.data, "keeper") };
}

/** A request to the agent's home files, or to the file at `path` below them, sent as written: fetch would fold `..` and
 *  `%2E%2E` segments before they leave. */
function raw(server, method, agentId, path, body) {
  const at = ["/v2/agents", agentId, "home", "files", ...(path === undefined ? [] : [path])].join("/");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method, path: at, headers: { authorization: `Bearer ${server.token}` } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
        const bytes = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(bytes.toString("utf8"));
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, body: json ?? bytes.toString("utf8") });
      });
    });
    req.once("error", reject).end(body);
  });
}

const files = (server, agentId = "keeper") => raw(server, "GET", agentId);
const put = (server, path, body, agentId = "keeper") => raw(server, "PUT", agentId, path, body);
const get = (server, path, agentId = "keeper") => raw(server, "GET", agentId, path);
const del = (server, path, agentId = "keeper") => raw(server, "DELETE", agentId, path);
const refused = (answer) => [answer.status, answer.body?.error?.code];

test("a new agent's home lists empty and is not on disk; a PUT makes it, the bytes come back whole, nested paths list, an overwrite replaces, a DELETE removes", async (t) => {
  const server = await served(t);
  assert.deepEqual((await files(server)).body, { agent_id: "keeper", files: [], complete: true, truncated: false });
  assert.equal(existsSync(join(server.data, "homes")), false, "nothing is made before the first write");

  // Every byte value, and a sequence that is not UTF-8: the file is the body, byte for byte.
  const binary = Buffer.concat([Buffer.from([...Array(256).keys()]), Buffer.from([0xc3, 0x28, 0xff, 0xfe, 0x00])]);
  const written = await put(server, "notes/a.bin", binary);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual({ ...written.body, modified_at: typeof written.body.modified_at }, { path: "notes/a.bin", size_bytes: binary.length, modified_at: "string", content_type: null });
  assert.equal((await stat(join(server.home, "notes", "a.bin"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(server.data, "homes"))).mode & 0o777, 0o700);
  const read = await get(server, "notes/a.bin");
  assert.equal(read.status, 200);
  assert.ok(read.bytes.equals(binary), "the bytes read are the bytes written");
  assert.deepEqual([read.headers["content-type"], read.headers["content-length"], read.headers["x-content-type-options"]], ["application/octet-stream", String(binary.length), "nosniff"]);

  assert.equal((await put(server, "top.md", "# First\n")).status, 200);
  assert.equal((await put(server, "deep/er/still/x.txt", "deep")).status, 200);
  assert.equal((await put(server, "sp%20aced.txt", "spaced")).status, 200);
  assert.equal((await get(server, "sp%20aced.txt")).body, "spaced");
  const listed = (await files(server)).body;
  assert.deepEqual(listed.files.map((f) => f.path), ["deep/er/still/x.txt", "notes/a.bin", "sp aced.txt", "top.md"]);
  assert.ok(listed.files.every((f) => f.host_owned === undefined), "none of them is host-owned");
  assert.deepEqual(listed.files.find((f) => f.path === "top.md").content_type, "text/markdown; charset=utf-8");

  const again = await put(server, "top.md", "# Second, longer\n");
  assert.deepEqual([again.status, again.body.size_bytes], [200, "# Second, longer\n".length]);
  assert.equal((await get(server, "top.md")).body, "# Second, longer\n");
  assert.equal((await files(server)).body.files.find((f) => f.path === "top.md").size_bytes, "# Second, longer\n".length);
  assert.deepEqual((await readdir(server.home)).filter((name) => name.startsWith(".")), [], "no temporary file is left");

  const gone = await del(server, "notes/a.bin");
  assert.deepEqual([gone.status, gone.bytes.length], [204, 0]);
  assert.deepEqual(refused(await get(server, "notes/a.bin")), [404, "not_found"]);
  assert.deepEqual(refused(await del(server, "notes/a.bin")), [404, "not_found"], "a second DELETE finds nothing");
  assert.deepEqual(refused(await del(server, "never-there.txt")), [404, "not_found"]);
  assert.deepEqual((await files(server)).body.files.map((f) => f.path), ["deep/er/still/x.txt", "sp aced.txt", "top.md"]);
  assert.ok((await stat(join(server.home, "notes"))).isDirectory(), "a directory a DELETE leaves empty stays");
  // A directory is not a file: neither written over nor deleted.
  assert.deepEqual(refused(await put(server, "deep/er", "x")), [400, "invalid_file_path"]);
  assert.deepEqual(refused(await del(server, "deep/er")), [400, "invalid_file_path"]);
  assert.deepEqual(refused(await put(server, "top.md/inside.txt", "x")), [400, "invalid_file_path"], "a path through a file");
});

test("traversal is refused before anything is touched: .., %2e%2e, a leading /, a backslash, an empty segment, a NUL; a dot-name is the server's", async (t) => {
  const server = await served(t);
  assert.equal((await put(server, "a/inside.txt", "inside")).status, 200);
  for (const path of ["../escape.txt", "a/../../escape.txt", "%2e%2e/escape.txt", "a/%2E%2E/%2e%2e/escape.txt", "/escape.txt", "%2Fescape.txt", "a%5C..%5Cescape.txt", "a\\b.txt", "a//b.txt", "a/./b.txt", "a%00b.txt", "%zz.txt", `${"x".repeat(256)}.txt`]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const answer = await raw(server, method, "keeper", path, method === "PUT" ? "out" : undefined);
      assert.deepEqual(refused(answer), [400, "invalid_file_path"], `${method} ${path}: ${JSON.stringify(answer.body)}`);
    }
  }
  for (const method of ["GET", "PUT", "DELETE"]) assert.deepEqual(refused(await raw(server, method, "keeper", "a/.hidden", method === "PUT" ? "x" : undefined)), [403, "system_file_forbidden"], method);
  assert.equal(existsSync(join(server.data, "homes", "escape.txt")) || existsSync(join(server.data, "escape.txt")) || existsSync(join(server.home, "escape.txt")), false, "nothing was written anywhere");
  assert.deepEqual((await files(server)).body.files.map((f) => f.path), ["a/inside.txt"]);
});

test("a link planted in the home is never followed: refused for read, write and delete, the files it names untouched, and left out of the list", async (t) => {
  const server = await served(t);
  assert.equal((await put(server, "real/kept.txt", "kept")).status, 200);
  const token = await readFile(join(server.data, ".token"), "utf8");
  const elsewhere = join(server.data, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "inner.txt"), "outside");
  await symlink(join(server.data, ".token"), join(server.home, "token.txt"));
  await symlink(elsewhere, join(server.home, "linked"));
  // One that points inside the home is refused too: the path must be the home's own names.
  await symlink(join(server.home, "real"), join(server.home, "alias"));

  for (const path of ["token.txt", "linked/inner.txt", "alias/kept.txt"]) {
    const read = await get(server, path);
    assert.deepEqual(refused(read), [404, "not_found"], `GET ${path}`);
    assert.ok(!read.bytes.toString().includes(token.trim()), "the token is never served");
    const written = await put(server, path, "overwritten");
    assert.deepEqual([...refused(written), written.body.error.details?.reason], [403, "system_file_forbidden", "link"], `PUT ${path}`);
    const removed = await del(server, path);
    assert.deepEqual([...refused(removed), removed.body.error.details?.reason], [403, "system_file_forbidden", "link"], `DELETE ${path}`);
  }
  assert.deepEqual(refused(await put(server, "linked/new.txt", "new")), [403, "system_file_forbidden"], "no file is made through a linked directory");
  assert.deepEqual(refused(await put(server, "linked/made/new.txt", "new")), [403, "system_file_forbidden"], "nor a directory");
  assert.equal(await readFile(join(server.data, ".token"), "utf8"), token);
  assert.equal(await readFile(join(elsewhere, "inner.txt"), "utf8"), "outside");
  assert.deepEqual(await readdir(elsewhere), ["inner.txt"]);
  assert.equal(await readFile(join(server.home, "real", "kept.txt"), "utf8"), "kept");
  assert.ok((await lstat(join(server.home, "token.txt"))).isSymbolicLink(), "the link itself stays");
  assert.deepEqual((await files(server)).body.files.map((f) => f.path), ["real/kept.txt"], "no link and nothing behind one is listed");
});

test("a directory swapped for a link between the check and the write is refused, and nothing lands where the link points", async (t) => {
  const server = await served(t);
  assert.equal((await put(server, "sub/first.txt", "first")).status, 200);
  const elsewhere = join(server.data, "elsewhere");
  await mkdir(elsewhere);
  let fired = 0;
  confineHooks.afterCheck = async (canonical) => {
    if (!canonical.endsWith("/sub/second.txt") || fired++) return;
    await rename(join(server.home, "sub"), join(server.home, "sub.moved"));
    await symlink(elsewhere, join(server.home, "sub"));
  };
  t.after(() => void (confineHooks.afterCheck = undefined));
  const answer = await put(server, "sub/second.txt", "second");
  assert.equal(fired, 1, "the swap happened");
  assert.deepEqual([...refused(answer), answer.body.error.details?.reason], [403, "system_file_forbidden", "link"]);
  assert.deepEqual(await readdir(elsewhere), [], "nothing was written through the link");
});

test("learning/ is the server's in any case: a GET, PUT or DELETE there is 403 however the path is spelled, nothing is made, and the list shows learning as one entry with none of its notes", async (t) => {
  const server = await served(t);
  assert.equal((await put(server, "mine.md", "mine")).status, 200);
  await mkdir(join(server.home, "learning", "deep"), { recursive: true });
  await writeFile(join(server.home, "learning", "notes.md"), "# Learned\n");
  await writeFile(join(server.home, "learning", "deep", "more.txt"), "more");

  const spellings = ["learning/x.md", "learning", "learning/notes.md", "learning/deep/more.txt", "learning/new/dir.txt", "./learning/x", "a/../learning/x", "%2e/learning/x", "learning//x", "learning%2Fx", "/learning/x", "Learning/x", "LEARNING/x", "./Learning/x", "a/../LeArNiNg/x", "Learning/notes.md", "LEARNING"];
  for (const path of spellings) {
    const written = await put(server, path, "overwritten");
    assert.deepEqual([...refused(written), written.body.error.details?.reason], [403, "system_file_forbidden", "host_owned"], `PUT ${path}: ${JSON.stringify(written.body)}`);
    assert.equal(written.body.error.message, "learning/ is written by the server, not through the API");
    const removed = await del(server, path);
    assert.deepEqual([...refused(removed), removed.body.error.details?.reason], [403, "system_file_forbidden", "host_owned"], `DELETE ${path}`);
    for (const query of ["", "?download=1"]) {
      const read = await get(server, `${path}${query}`);
      assert.deepEqual([...refused(read), read.body.error?.details?.reason], [403, "system_file_forbidden", "host_owned"], `GET ${path}${query}`);
      assert.equal(read.body.error.message, "read it through /v2/agents/keeper/learning");
      assert.ok(!read.bytes.toString().includes("Learned"), "no note is served");
    }
  }
  assert.deepEqual((await readdir(server.home)).sort(), ["learning", "mine.md"], "no Learning/, LEARNING/ or a/ was made");
  assert.deepEqual((await readdir(join(server.home, "learning"))).sort(), ["deep", "notes.md"]);
  assert.equal(await readFile(join(server.home, "learning", "notes.md"), "utf8"), "# Learned\n", "the planted note is untouched");

  const listed = (await files(server)).body;
  assert.deepEqual(listed.files.find((f) => f.path === "learning"), { path: "learning", host_owned: true }, "learning is one entry, its name alone");
  assert.deepEqual(listed.files.map((f) => f.path), ["learning", "mine.md"], "none of its notes is listed");
  assert.equal(listed.files.find((f) => f.path === "mine.md").host_owned, undefined);
  // A name that only starts like it, or a learning/ below the top, is the client's.
  assert.equal((await put(server, "learning2/x.md", "x")).status, 200);
  assert.equal((await put(server, "notes/learning/y.md", "y")).status, 200);
  assert.equal((await get(server, "notes/learning/y.md")).body, "y");
  const again = (await files(server)).body.files;
  assert.deepEqual(again.map((f) => f.path), ["learning", "learning2/x.md", "mine.md", "notes/learning/y.md"]);
  assert.ok(again.filter((f) => f.path !== "learning").every((f) => f.host_owned === undefined && typeof f.size_bytes === "number"));
});

test("a home path takes only plain segments, and a host-owned name in another spelling a disk could take for it is the server's, while other names stay the client's", async (t) => {
  const server = await served(t);
  assert.equal((await put(server, "mine.md", "mine")).status, 200);
  await mkdir(join(server.home, "learning"), { recursive: true });
  await writeFile(join(server.home, "learning", "notes.md"), "# Learned\n");
  const encoded = (path) => path.split("/").map(encodeURIComponent).join("/");
  const each = async (path, check) => {
    for (const method of ["GET", "PUT", "DELETE"]) check(method, await raw(server, method, "keeper", encoded(path), method === "PUT" ? "x" : undefined));
  };
  // A segment holding a default-ignorable code point, or not in its NFC form, is no plain segment.
  for (const path of ["learn\u200Cing/notes.md", "learn\u200Bing/notes.md", "learn\u00ADing/notes.md", "\uFEFFlearning/notes.md", "learnin\u0301g/x", "\u212Aeeper/x", "a\u2060b/x", "a\u034Fb/x"]) {
    await each(path, (method, answer) => {
      assert.deepEqual(refused(answer), [400, "invalid_file_path"], `${method} ${JSON.stringify(path)}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.error.message, "a path segment must be plain text (NFC, no invisible characters)");
    });
  }
  // Plain, and folded to learning: dotless and dotted i, fullwidth letters.
  for (const path of ["learn\u0131ng/notes.md", "LEARN\u0130NG/notes.md", "\uFF4C\uFF45\uFF41\uFF52\uFF4E\uFF49\uFF4E\uFF47/notes.md", "\uFF2C\uFF25\uFF21\uFF32\uFF2E\uFF29\uFF2E\uFF27"]) {
    await each(path, (method, answer) => {
      assert.deepEqual([...refused(answer), answer.body.error?.details?.reason], [403, "system_file_forbidden", "host_owned"], `${method} ${JSON.stringify(path)}`);
      assert.ok(!answer.bytes.toString().includes("Learned"), "no note is served");
    });
  }
  assert.deepEqual((await readdir(server.home)).sort(), ["learning", "mine.md"], "nothing was made");
  assert.equal(await readFile(join(server.home, "learning", "notes.md"), "utf8"), "# Learned\n");
  // A name that only looks near it, one below the top, and a plain non-ASCII name are the client's.
  for (const path of ["learning2/x.md", "notes/learning/y.md", "caf\u00E9.md"]) {
    assert.equal((await raw(server, "PUT", "keeper", encoded(path), "client")).status, 200, path);
    assert.equal((await raw(server, "GET", "keeper", encoded(path))).body, "client", path);
  }
  const listed = (await files(server)).body.files;
  assert.deepEqual(listed.map((f) => f.path), ["caf\u00E9.md", "learning", "learning2/x.md", "mine.md", "notes/learning/y.md"]);
  assert.deepEqual(listed.filter((f) => f.host_owned).map((f) => f.path), ["learning"]);
});

test("two agents whose ids differ only in case get homes of their own: keys that differ in any case, in lower case only, and neither sees the other's files", async (t) => {
  const server = await served(t);
  assert.equal((await server.api("POST", "/agents", agent("Keeper"))).status, 201, "the store keeps Keeper apart from keeper");
  const [lower, upper] = [homeKey("keeper"), homeKey("Keeper")];
  assert.notEqual(lower.toLowerCase(), upper.toLowerCase(), "a disk that folds case still tells them apart");
  for (const key of [lower, upper]) {
    assert.equal(key, key.toLowerCase(), "lower case only");
    assert.match(key, /^[a-z0-9._-]+-[0-9a-f]{16}$/);
  }
  assert.equal(homeOf(server.data, "Keeper"), join(server.data, "homes", upper));
  assert.equal((await put(server, "only-lower.md", "lower")).status, 200);
  assert.equal((await put(server, "only-upper.md", "upper", "Keeper")).status, 200);
  assert.deepEqual((await files(server)).body.files.map((f) => f.path), ["only-lower.md"]);
  assert.deepEqual((await files(server, "Keeper")).body.files.map((f) => f.path), ["only-upper.md"]);
  assert.deepEqual(refused(await get(server, "only-upper.md")), [404, "not_found"], "keeper does not read Keeper's file");
  assert.deepEqual(refused(await get(server, "only-lower.md", "Keeper")), [404, "not_found"], "nor Keeper keeper's");
  assert.deepEqual(refused(await del(server, "only-upper.md")), [404, "not_found"], "nor delete it");
  assert.deepEqual((await readdir(join(server.data, "homes"))).sort(), [lower, upper].sort());
});

test("a write goes as deep as the list does: 16 directories, written and listed; 17 refused; a deeper one planted on disk marks the list truncated", async (t) => {
  const server = await served(t);
  const at = (n) => `${Array.from({ length: n }, (_, i) => `d${i}`).join("/")}/x.txt`;
  assert.equal((await put(server, at(16), "deep")).status, 200);
  assert.deepEqual(refused(await put(server, at(17), "deeper")), [400, "invalid_file_path"]);
  const first = (await files(server)).body;
  assert.deepEqual([first.files.map((f) => f.path), first.truncated], [[at(16)], false]);
  await mkdir(join(server.home, ...Array.from({ length: 17 }, (_, i) => `d${i}`)), { recursive: true });
  await writeFile(join(server.home, at(17)), "planted");
  const listed = (await files(server)).body;
  assert.deepEqual([listed.files.map((f) => f.path), listed.truncated], [[at(16)], true], "the list says it stopped short");
});

test("a write that makes directories syncs each into its parent before it is answered: the data directory, homes/, the home and every one on the way", { skip: process.platform !== "linux" && "reads descriptors from /proc" }, async (t) => {
  const server = await served(t);
  const probe = await open(join(server.data, ".probe"), "w");
  const FileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  const synced = [];
  const realSync = FileHandle.sync;
  FileHandle.sync = async function () {
    synced.push(readlinkSync(`/proc/self/fd/${this.fd}`));
    return realSync.call(this);
  };
  t.after(() => void (FileHandle.sync = realSync));
  assert.equal((await put(server, "a/b/c.txt", "c")).status, 200);
  const data = await realpath(server.data);
  const dirs = synced.filter((path) => !path.endsWith(".tmp"));
  const home = join(data, "homes", homeKey("keeper"));
  for (const dir of [data, join(data, "homes"), home, join(home, "a"), join(home, "a", "b")]) assert.ok(dirs.includes(dir), `${dir} is synced: ${JSON.stringify(dirs)}`);
  synced.length = 0;
  assert.equal((await put(server, "a/b/d.txt", "d")).status, 200);
  assert.deepEqual(synced.filter((path) => !path.endsWith(".tmp")), [join(home, "a", "b")], "a write in a directory already there syncs that one alone");
});

test("where the confinement walks by path (no /proc/self/fd, as on macOS) PUT and DELETE are 501 and write or remove nothing; capabilities say writes: false, and the list and reads still answer", async (t) => {
  workspaceTestHooks.byPath = true;
  t.after(() => void (workspaceTestHooks.byPath = undefined));
  const server = await served(t);
  assert.equal((await server.api("GET", "/capabilities")).body.home.writes, false);
  await mkdir(join(server.home, "notes"), { recursive: true });
  await writeFile(join(server.home, "notes", "planted.md"), "planted");
  for (const answer of [await put(server, "new.md", "x"), await put(server, "notes/planted.md", "over"), await del(server, "notes/planted.md")]) {
    assert.deepEqual(refused(answer), [501, "unsupported_here"]);
    assert.equal(answer.body.error.message, "This server can't write a home's files safely here: a write needs /proc/self/fd, as on Linux, which this platform lacks. Reads and the list still work.");
  }
  assert.deepEqual(await readdir(server.home), ["notes"], "nothing was written");
  assert.equal(await readFile(join(server.home, "notes", "planted.md"), "utf8"), "planted", "nothing was overwritten or removed");
  assert.deepEqual((await files(server)).body.files.map((f) => f.path), ["notes/planted.md"], "the list walks by path and answers");
  assert.equal((await get(server, "notes/planted.md")).body, "planted", "a read walks by path and answers");
});

test("a body over the cap is 413 and writes nothing; one at the cap is taken", async (t) => {
  const server = await served(t);
  const caps = (await server.api("GET", "/capabilities")).body;
  const cap = caps.home.max_file_bytes;
  const over = await put(server, "big.bin", Buffer.alloc(cap + 1, 7));
  assert.deepEqual([...refused(over), over.body.error.details?.limit], [413, "payload_too_large", "max_body_bytes"]);
  assert.equal(caps.limits[over.body.error.details.limit], cap, "the limit it names is the cap");
  assert.deepEqual(refused(await get(server, "big.bin")), [404, "not_found"]);
  const at = await put(server, "big.bin", Buffer.alloc(cap, 7));
  assert.deepEqual([at.status, at.body.size_bytes], [200, cap]);
});

test("an unknown agent is 404 on every home route; an archived agent's home is read and written, as its definition is", async (t) => {
  const server = await served(t);
  for (const answer of [await files(server, "nobody"), await get(server, "a.txt", "nobody"), await put(server, "a.txt", "x", "nobody"), await del(server, "a.txt", "nobody")]) assert.deepEqual(refused(answer), [404, "not_found"]);
  assert.equal(existsSync(homeOf(server.data, "nobody")), false, "no home is made for an agent that is not there");

  assert.equal((await put(server, "before.md", "before")).status, 200);
  assert.equal((await server.api("POST", "/agents/keeper/archive")).status, 200);
  // The precedent: an archived agent's definition takes an edit.
  assert.equal((await server.api("PUT", "/agents/keeper/definition", agent("keeper", { version: 2, instructions: "Answer briefly." }))).status, 200);
  assert.deepEqual((await files(server)).body.files.map((f) => f.path), ["before.md"]);
  assert.equal((await get(server, "before.md")).body, "before");
  assert.equal((await put(server, "after.md", "after")).status, 200);
  assert.equal((await del(server, "before.md")).status, 204);
  assert.deepEqual((await files(server)).body.files.map((f) => f.path), ["after.md"]);
});

test("GET and PUT /agents/{id}/home stay the contract's 501, the new routes take only their methods, and capabilities.home says what the home is", async (t) => {
  const server = await served(t);
  const exported = await server.api("GET", "/agents/keeper/home");
  assert.deepEqual([exported.status, exported.body.error.code, exported.body.error.capability], [501, "unsupported_here", "home.export"]);
  const imported = await server.api("PUT", "/agents/keeper/home", {});
  assert.deepEqual([imported.status, imported.body.error.code, imported.body.error.capability], [501, "unsupported_here", "home.import"]);
  const post = await raw(server, "POST", "keeper", "a.txt", "x");
  assert.deepEqual([...refused(post), post.headers.allow], [405, "method_not_allowed", "GET, PUT, DELETE"]);
  assert.deepEqual([(await raw(server, "PUT", "keeper", undefined, "x")).headers.allow], ["GET"]);
  assert.deepEqual(refused(await files({ ...server, token: "wrong-token" })), [401, "unauthenticated"]);

  const caps = (await server.api("GET", "/capabilities")).body;
  assert.deepEqual(caps.home, { disk: "local", host_owned: ["learning"], max_file_bytes: caps.limits.max_body_bytes, writes: process.platform === "linux" });
  assert.deepEqual(caps.features.home, { export: false, import: false, check: false }, "the contract's packed home is still off");
});
