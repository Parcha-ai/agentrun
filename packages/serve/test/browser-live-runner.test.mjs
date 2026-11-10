// The browser tool's hand-over on the runner path (browser-live.ts sessionHandovers, as tools.ts's browser binding calls
// it): with the tool host's live-viewer seam (ToolHost.liveViewers, built as runner/adapter-run-spec.ts builds it, over
// the real store and a real claim from runs.claimMany), each session's viewer goes to the store as it launches or is
// reopened, its own row goes at its release, every row of the run at the run's release, and nothing goes to the run's
// directory. Without the seam (the old per-run process), the run's directory's files, as before. The server's reads over
// the store (liveViewerLink, the dep run-reads-over-store's runBrowserState takes; liveViewerById for the proxy) see what
// the runner put. The token's plaintext is in no store column and no file under the data directory.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BROWSER_LIVE_DIR, dropLiveViewer, liveViewerById, liveViewerFor, liveViewerLink, putLiveViewer, readHandovers, readLiveViewers, sessionHandovers } from "../dist/browser-live.js";
import { queued, storeOn } from "./store-helpers.mjs";
import { raw, storeAtRest } from "./store-target.mjs";

/** A test seal key, no real one. */
const KEY = randomBytes(32);
const viewer = (tag) => {
  const id = randomBytes(16).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  return { id, token, tag, row: { session: { tag }, liveView: { fullscreen: `http://127.0.0.1:45123/v/${id}#t=${token}` } } };
};
/** Every file under `dir`, path and bytes. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [[path, readFileSync(path)]] : [];
});
/** Every computer_viewers row, every column, raw (the store's file, or its Postgres schema). */
const rawRows = async (file) => {
  const db = await raw(file, { readOnly: true });
  try {
    return await db.all("SELECT * FROM computer_viewers ORDER BY run_id, kind, tag");
  } finally {
    await db.close();
  }
};
const holds = (rows, text) => rows.some((row) => Object.values(row).some((value) => (value instanceof Uint8Array ? Buffer.from(value).includes(text) : String(value).includes(text))));

/** A runner-path run: the real store, a run claimed through runs.claimMany, its directory, and the tool host's seam as
 *  runner/adapter-run-spec.ts builds it. */
async function runnerRun(t) {
  const { store, clock, file, dir } = await storeOn(t);
  await queued(store, "run-1");
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const root = join(dir, "runs", "run-1");
  await mkdir(root, { recursive: true });
  const seam = { put: (handover) => putLiveViewer(store, KEY, claim, handover), drop: (tag) => dropLiveViewer(store, claim, tag) };
  return { store, clock, file, dir, claim, root, seam };
}

test("on the runner path the browser's hand-over goes to the store under the run's claim, never to the run's directory: put at launch and at a reopen, its own row dropped at its release, every row at the run's release", async (t) => {
  const r = await runnerRun(t);
  const handed = sessionHandovers(r.root, r.seam);
  const a = viewer("ar-run-1-1");
  const b = viewer("ar-run-1-2");
  await handed.changed(a.row, "created");
  r.clock.now += 10;
  await handed.reopened(b.tag, b.row.liveView.fullscreen);
  assert.deepEqual((await readLiveViewers(r.store, KEY, "run-1")).map(({ id, token, tag }) => ({ id, token, tag })), [b, a].map(({ id, token, tag }) => ({ id, token, tag })));
  assert.equal(existsSync(join(r.root, BROWSER_LIVE_DIR)), false, "nothing in the run's directory");
  // A session with no viewer, or a vendor's own URL, hands nothing over.
  await handed.changed({ session: { tag: "ar-run-1-3" }, liveView: null }, "created");
  await handed.changed({ session: { tag: "ar-run-1-4" }, liveView: { fullscreen: "https://vendor.example/live/abc" } }, "created");
  assert.equal((await readLiveViewers(r.store, KEY, "run-1")).length, 2);
  await handed.changed(b.row, "released");
  assert.deepEqual((await readLiveViewers(r.store, KEY, "run-1")).map((v) => v.tag), [a.tag], "its own row alone");
  await handed.released();
  assert.deepEqual(await readLiveViewers(r.store, KEY, "run-1"), [], "every row of the run");
  assert.deepEqual(await rawRows(r.file), []);
});

test("without the seam (the old per-run process) the hand-over is the run's directory's files, as before", async (t) => {
  const r = await runnerRun(t);
  const handed = sessionHandovers(r.root);
  const a = viewer("ar-run-1-1");
  await handed.changed(a.row, "created");
  assert.deepEqual((await readHandovers(r.root)).map(({ id, token, tag }) => ({ id, token, tag })), [{ id: a.id, token: a.token, tag: a.tag }]);
  assert.deepEqual(await rawRows(r.file), [], "nothing in the store");
  await handed.changed(a.row, "released");
  assert.deepEqual(await readHandovers(r.root), []);
  await handed.changed(a.row, "created");
  await handed.released();
  assert.equal(existsSync(join(r.root, BROWSER_LIVE_DIR)), false, "the run's release takes the directory");
});

test("the server reads what the runner put: liveViewerLink names the newest viewer whose port answers, liveViewerById the one the proxy asks for; none once released or when no port answers", async (t) => {
  const r = await runnerRun(t);
  const handed = sessionHandovers(r.root, r.seam);
  const a = viewer("ar-run-1-1");
  const b = viewer("ar-run-1-2");
  await handed.changed(a.row, "created");
  r.clock.now += 10;
  await handed.changed(b.row, "created");
  const answering = new Set([a.id, b.id]);
  const answers = async (handover) => answering.has(handover.id);
  assert.deepEqual(await liveViewerLink(r.store, KEY, "run-1", answers), { viewer: `/v2/runs/run-1/browser/live/v/${b.id}#t=${b.token}` }, "the newest");
  answering.delete(b.id);
  assert.deepEqual(await liveViewerLink(r.store, KEY, "run-1", answers), { viewer: `/v2/runs/run-1/browser/live/v/${a.id}#t=${a.token}` }, "the newest that answers");
  assert.equal((await liveViewerById(r.store, KEY, "run-1", a.id))?.token, a.token, "the proxy's lookup");
  answering.clear();
  assert.equal(await liveViewerLink(r.store, KEY, "run-1", answers), undefined, "no port answers: no viewer");
  answering.add(a.id);
  await handed.released();
  assert.equal(await liveViewerLink(r.store, KEY, "run-1", answers), undefined, "none once released");
  assert.equal(await liveViewerById(r.store, KEY, "run-1", a.id), undefined);
});

test("on the runner path the viewer's token is in no computer_viewers column in plaintext and in no file under the data directory: the store's file (its journal and command rows among its tables) and the run's directory hold none of it", async (t) => {
  const r = await runnerRun(t);
  const handed = sessionHandovers(r.root, r.seam);
  const a = viewer("ar-run-1-1");
  await handed.changed(a.row, "created");
  await r.store.command("run-1", { kind: "steer", body: { content: "go on" } });
  await r.store.flush();
  assert.equal((await liveViewerById(r.store, KEY, "run-1", a.id))?.token, a.token, "the owner's read opens it");
  const rows = await rawRows(r.file);
  assert.equal(rows.length, 1);
  assert.equal(holds(rows, a.token), false, "no column holds it in plaintext");
  assert.deepEqual(filesUnder(r.dir).filter(([, bytes]) => bytes.includes(a.token)).map(([path]) => path), [], "no file under the data directory holds it");
  // The store at rest, whichever it is (its file and WAL, or every column of its Postgres schema).
  assert.deepEqual((await storeAtRest(r.file)).filter(([, bytes]) => bytes.includes(a.token)).map(([where]) => where), [], "nothing in the store at rest holds it");
  assert.equal(JSON.stringify(await r.store.commands("run-1", 0)).includes(a.token), false, "no command row");
});

test("the live route over the store serves only what the runner put: a viewer's page by its path id, the viewer's files while the run has one open, nothing at any other address, and nothing once released", async (t) => {
  const r = await runnerRun(t);
  const handed = sessionHandovers(r.root, r.seam);
  const a = viewer("ar-run-1-1");
  const b = viewer("ar-run-1-2");
  await handed.changed(a.row, "created");
  r.clock.now += 10;
  await handed.changed(b.row, "created");
  const route = async (rest) => (await liveViewerFor(r.store, KEY, "run-1", rest))?.id;
  assert.equal(await route(`/v/${a.id}`), a.id, "a viewer's page, by its own path id");
  assert.equal(await route(`/v/${b.id}`), b.id);
  assert.equal(await route("/viewer.js"), b.id, "the viewer's files, while one is open (the newest)");
  assert.equal(await route("/viewer.css"), b.id);
  assert.equal(await route("/v/AAAAAAAAAAAAAAAAAAAAAA"), undefined, "another viewer's path is not served");
  for (const rest of ["/", "/v/short", `/v/${a.id}/ws`, "/other.js", `/v/${a.id}/../x`]) assert.equal(await route(rest), undefined, `${rest}: no live view at that address`);
  assert.equal(await liveViewerFor(r.store, KEY, "run-2", "/viewer.js"), undefined, "another run's viewer is never this run's");
  await handed.released();
  assert.equal(await route(`/v/${a.id}`), undefined, "none once released");
  assert.equal(await route("/viewer.js"), undefined);
});
