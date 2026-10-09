import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { etagOf, isFile, matches, modelDisk, runDisk, type DiskBackend } from "../disk.ts";

const B = (s: string) => Buffer.from(s);

describe("etags", () => {
  it("are a content hash: same bytes, same tag; different bytes, different tag", () => {
    assert.equal(etagOf(B("a")), etagOf(B("a")));
    assert.notEqual(etagOf(B("a")), etagOf(B("b")));
    assert.match(etagOf(B("a")), /^"[0-9a-f]{32}"$/);
  });
  it("match an If-None-Match that is one tag, a list, a weak tag or *", () => {
    const t = etagOf(B("a"));
    assert.ok(matches(t, t) && matches(`"x", ${t}`, t) && matches(`W/${t}`, t) && matches("*", t));
    assert.ok(!matches(undefined, t) && !matches('"other"', t) && !matches("", t));
  });
});

async function behavesLikeADisk(name: string, make: () => Promise<DiskBackend> | DiskBackend, writable: string): Promise<void> {
  describe(`${name}: the disk the tab's storage messages see`, () => {
    it("a file that does not exist yet is 204, not an error", async () => {
      assert.deepEqual(await (await make()).read("creature/never.sqlite"), { status: 204 });
    });
    it("a write is read back as the same bytes with an etag, and a read with that etag is 304", async () => {
      const d = await make();
      assert.deepEqual(await d.write(writable, B("hello")), { status: 200, bytes: 5 });
      const r = await d.read(writable);
      assert.ok(isFile(r) && r.bytes.toString() === "hello");
      const again = await d.read(writable, isFile(r) ? r.etag : "");
      assert.deepEqual(again, { status: 304, etag: isFile(r) ? r.etag : "" });
    });
    it("a changed file is sent again with its new etag", async () => {
      const d = await make();
      await d.write(writable, B("one"));
      const first = await d.read(writable);
      assert.ok(isFile(first));
      await d.write(writable, B("two"));
      const second = await d.read(writable, isFile(first) ? first.etag : "");
      assert.ok(isFile(second) && second.bytes.toString() === "two" && second.etag !== (isFile(first) ? first.etag : ""));
    });
  });
}

await behavesLikeADisk("the model disk", () => modelDisk(), "creature/designs.sqlite");

describe("the model disk", () => {
  it("is emptied by a reset", async () => {
    const d = modelDisk();
    await d.write("a", B("x"));
    d.reset!();
    assert.deepEqual(await d.read("a"), { status: 204 });
  });
});

// A stand-in for the 03 server's work route: bearer secret, a writable allowlist, and a tab that must hold the run.
describe("the run's disk over the 03 server's work route", () => {
  let server: Server;
  let origin = "";
  const files = new Map<string, Buffer>();
  const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
  const SECRET = "run-secret-1234567890";
  const ALLOWED = new Set(["creature/designs.sqlite", "creature/body.json", "creature/creature.xml"]);
  let holder = "tab-A";
  let moving = false;

  before(async () => {
    server = createServer(async (req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      const m = /^\/api\/runs\/([^/]+)\/work\/(.+)$/.exec(req.url ?? "");
      if (!m || req.headers.authorization !== `Bearer ${SECRET}`) return void res.writeHead(404).end();
      if (moving) return void res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "the run's files cannot be read while no pipe holds it" }));
      const path = decodeURIComponent(m[2]!);
      if (req.method === "GET") {
        const f = files.get(path);
        return void (f ? res.writeHead(200).end(f) : res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `no file ${path}` })));
      }
      if (!ALLOWED.has(path)) return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: `the tab may not write ${path}` }));
      if (req.headers["x-pda-tab"] !== holder) return void res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "this tab does not hold the run" }));
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      files.set(path, Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());

  const disk = (tab: string | undefined = "tab-A", secret = SECRET) => runDisk({ origin, run: "stage", secret }, () => tab);

  it("behaves like a disk, through the server", async () => {
    const d = disk();
    assert.deepEqual(await d.read("creature/nothing.sqlite"), { status: 204 });
    assert.deepEqual(await d.write("creature/designs.sqlite", B("design")), { status: 200, bytes: 6 });
    const r = await d.read("creature/designs.sqlite");
    assert.ok(isFile(r) && r.bytes.toString() === "design");
    assert.equal((await d.read("creature/designs.sqlite", isFile(r) ? r.etag : "")).status, 304);
  });

  it("a design save is 200 and a write to memory.sqlite is 403, with the server's words", async () => {
    const d = disk();
    assert.equal((await d.write("creature/designs.sqlite", B("x"))).status, 200);
    assert.deepEqual(await d.write("creature/memory.sqlite", B("x")), { status: 403, error: "the tab may not write creature/memory.sqlite" });
  });

  it("a tab that does not hold the run gets the server's 409, and no tab at all is refused before asking", async () => {
    assert.deepEqual(await disk("tab-B").write("creature/designs.sqlite", B("x")), { status: 409, error: "this tab does not hold the run" });
    const before = seen.length;
    const noTab = runDisk({ origin, run: "stage", secret: SECRET }, () => undefined);
    assert.deepEqual(await noTab.write("creature/designs.sqlite", B("x")), { status: 409, error: "no tab holds the run" });
    assert.equal(seen.length, before, "nothing was sent to the server");
  });

  it("sends the run's secret and the holder's tab id to the server, and encodes the path", async () => {
    await disk("tab-A").write("creature/designs.sqlite", B("x"));
    const put = seen.filter((s) => s.method === "PUT").at(-1)!;
    assert.equal(put.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(put.headers["x-pda-tab"], "tab-A");
    assert.equal(put.url, "/api/runs/stage/work/creature/designs.sqlite");
  });

  it("a wrong secret is a 404 from the server and reads as a missing file, never as someone else's data", async () => {
    assert.deepEqual(await disk("tab-A", "wrong").read("creature/designs.sqlite"), { status: 204 });
  });

  it("while the run moves (the server cannot read its files) a poller is told nothing changed, and a first read, nothing yet: never an error", async () => {
    const d = disk();
    await d.write("creature/designs.sqlite", B("settled"));
    const etag = (await d.read("creature/designs.sqlite") as { etag: string }).etag;
    moving = true;
    try {
      assert.deepEqual(await d.read("creature/designs.sqlite", etag), { status: 304, etag });
      assert.deepEqual(await d.read("home/policy.json"), { status: 204 });
    } finally {
      moving = false;
    }
    assert.equal((await d.read("creature/designs.sqlite")).status, 200, "and it reads again once the run is held");
  });

  it("a server that is not there is a 502 with a reason", async () => {
    const d = runDisk({ origin: "http://127.0.0.1:1", run: "stage", secret: SECRET }, () => "tab-A");
    const r = await d.read("creature/designs.sqlite");
    assert.ok(r.status === 502 && /did not answer/.test((r as { error: string }).error));
  });
});

