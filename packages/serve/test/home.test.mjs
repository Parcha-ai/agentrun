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
import { agent, serve } from "./support.mjs";

/** A server with the agent `keeper`, and where its home is on disk. */
async function served(t) {
  const server = await serve(t);
  assert.equal((await server.api("POST", "/agents", agent("keeper"))).status, 201);
  return { ...server, home: join(server.data, "homes", "keeper") };
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

test("learning/ is the server's: a PUT or DELETE there is 403 however the path is spelled, while a file planted there is read and listed host_owned", async (t) => {
  const server = await served(t);
  assert.equal((await put(server, "mine.md", "mine")).status, 200);
  await mkdir(join(server.home, "learning", "deep"), { recursive: true });
  await writeFile(join(server.home, "learning", "notes.md"), "# Learned\n");
  await writeFile(join(server.home, "learning", "deep", "more.txt"), "more");

  for (const path of ["learning/x.md", "learning", "learning/notes.md", "learning/new/dir.txt", "./learning/x", "a/../learning/x", "%2e/learning/x", "learning//x", "learning%2Fx", "/learning/x"]) {
    const written = await put(server, path, "overwritten");
    assert.deepEqual([...refused(written), written.body.error.details?.reason], [403, "system_file_forbidden", "host_owned"], `PUT ${path}: ${JSON.stringify(written.body)}`);
    assert.equal(written.body.error.message, "learning/ is written by the server, not through the API");
    assert.deepEqual(refused(await del(server, path)), [403, "system_file_forbidden"], `DELETE ${path}`);
  }
  assert.equal(await readFile(join(server.home, "learning", "notes.md"), "utf8"), "# Learned\n", "the planted file is untouched");
  assert.equal(existsSync(join(server.home, "learning", "x.md")) || existsSync(join(server.home, "learning", "x")), false);

  const read = await get(server, "learning/notes.md");
  assert.deepEqual([read.status, read.body], [200, "# Learned\n"]);
  const listed = (await files(server)).body.files.map(({ path, host_owned }) => ({ path, host_owned }));
  assert.deepEqual(listed, [{ path: "learning/deep/more.txt", host_owned: true }, { path: "learning/notes.md", host_owned: true }, { path: "mine.md", host_owned: undefined }]);
  // A name that only starts like it is the client's.
  assert.equal((await put(server, "learning2/x.md", "x")).status, 200);
  assert.equal((await files(server)).body.files.find((f) => f.path === "learning2/x.md").host_owned, undefined);
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
  for (const dir of [data, join(data, "homes"), join(data, "homes", "keeper"), join(data, "homes", "keeper", "a"), join(data, "homes", "keeper", "a", "b")]) assert.ok(dirs.includes(dir), `${dir} is synced: ${JSON.stringify(dirs)}`);
  synced.length = 0;
  assert.equal((await put(server, "a/b/d.txt", "d")).status, 200);
  assert.deepEqual(synced.filter((path) => !path.endsWith(".tmp")), [join(data, "homes", "keeper", "a", "b")], "a write in a directory already there syncs that one alone");
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
  assert.equal(existsSync(join(server.data, "homes", "nobody")), false, "no home is made for an agent that is not there");

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
  assert.deepEqual(caps.home, { disk: "local", host_owned: ["learning"], max_file_bytes: caps.limits.max_body_bytes });
  assert.deepEqual(caps.features.home, { export: false, import: false, check: false }, "the contract's packed home is still off");
});
