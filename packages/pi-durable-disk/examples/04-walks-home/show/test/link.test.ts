import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { linkKey, LiveLink, parseLink } from "../link.ts";

const dir = join(homedir(), "tmp-d5", `link-test-${Date.now().toString(36)}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const L = (port: number, run: string, secret: string) => `http://127.0.0.1:${port}/run/${run}#${secret}\n`;

test("a run link gives the origin, the run, the secret and the websocket address", () => {
  const t = parseLink(L(8794, "r1", "sekret-0123456789"));
  assert.deepEqual(t, { origin: "http://127.0.0.1:8794", run: "r1", secret: "sekret-0123456789", wsUrl: "ws://127.0.0.1:8794/ws" });
  assert.equal(parseLink("https://h.example/run/a#b").wsUrl, "wss://h.example/ws");
});

test("a link without a run or a secret is refused", () => {
  assert.throws(() => parseLink("http://127.0.0.1:1/"), /not a run link/);
  assert.throws(() => parseLink("http://127.0.0.1:1/run/x"), /not a run link/);
  assert.throws(() => parseLink("nonsense"));
});

test("the key tells runs apart by origin, run id and secret, and does not contain the secret", () => {
  const a = parseLink(L(1, "r", "secret-aaaaaaaa"));
  assert.notEqual(linkKey(a), linkKey(parseLink(L(2, "r", "secret-aaaaaaaa"))), "another port");
  assert.notEqual(linkKey(a), linkKey(parseLink(L(1, "q", "secret-aaaaaaaa"))), "another run");
  assert.notEqual(linkKey(a), linkKey(parseLink(L(1, "r", "secret-bbbbbbbb"))), "the same run id with a new secret: a restarted server");
  assert.equal(linkKey(a), linkKey(parseLink(L(1, "r", "secret-aaaaaaaa"))));
  assert.ok(!linkKey(a).includes("secret-aaaaaaaa"));
});

test("a live link follows its file: it reads again when the file is rewritten, and is undefined while the file is not there", () => {
  const file = join(dir, "link");
  rmSync(file, { force: true });
  const live = new LiveLink(file);
  assert.equal(live.tryCurrent(), undefined);
  assert.throws(() => live.current());
  writeFileSync(file, L(8794, "r1", "secret-one-1234567"), { mode: 0o600 });
  assert.equal(live.current().run, "r1");
  assert.equal(live.current(), live.current(), "unchanged: the same parsed object, no re-read");
  // A restart writes a new link; the stamp changes even if the size is the same.
  writeFileSync(file, L(8794, "r2", "secret-two-1234567"), { mode: 0o600 });
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(live.current().run, "r2");
  rmSync(file);
  assert.equal(live.tryCurrent(), undefined, "the server is gone: no link");
});
