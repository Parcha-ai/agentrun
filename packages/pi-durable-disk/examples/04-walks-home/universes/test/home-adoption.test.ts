// The winner's adoption by the tab's server, against a scripted server: which run cleanup must keep (`handed`), when
// cleanup may go on (`close`), and what GET /api/home answers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunRef } from "@parcha/pi-durable-disk";
import { homeAdoption, type HomeAdoptionOptions } from "../home-adoption.ts";

const RUN: RunRef = { disk: "dsk-test", region: "test", id: "d1-u8" };

function setup(answer: () => Promise<Response>, policy: HomeAdoptionOptions["policy"] = async () => "home/policy.json") {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "home-adoption-"));
  const tokenFile = join(dir, "admin-token");
  writeFileSync(tokenFile, "secret-admin-token\n", { mode: 0o600 });
  const asked: { url: string; auth: string | null }[] = [];
  const failed: string[] = [];
  const homes = homeAdoption({
    server: "http://127.0.0.1:9",
    tokenFile,
    policy,
    onPolicyFailed: (_run, error) => void failed.push(error.message),
    log: () => {},
    fetch: (async (url: string, init: RequestInit) => {
      asked.push({ url, auth: new Headers(init.headers).get("authorization") });
      return answer();
    }) as typeof fetch,
  });
  return { homes, asked, failed, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const adopted = () => Promise.resolve(Response.json({ link: "/run/d1-u8#secret" }));

test("an adopted run is handed, and home carries its link and policy", async () => {
  const s = setup(adopted);
  try {
    await s.homes.adopt(RUN, "u8");
    assert.deepEqual(s.asked, [{ url: "http://127.0.0.1:9/api/runs/d1-u8/attach", auth: "Bearer secret-admin-token" }]);
    assert.equal(s.homes.handed, "d1-u8");
    assert.deepEqual(s.homes.home, { run: "d1-u8", url: "http://127.0.0.1:9/run/d1-u8#secret", policy: "home/policy.json" });
  } finally {
    s.done();
  }
});

test("a policy check that throws leaves the adopted run handed, with no policy going home", async () => {
  const s = setup(adopted, async () => {
    throw new Error("body.json is not JSON");
  });
  try {
    await s.homes.adopt(RUN, "u8");
    assert.equal(s.homes.handed, "d1-u8", "the tab's server holds it: cleanup must not delete it");
    assert.equal(s.homes.home?.policy, null);
    assert.deepEqual(s.failed, ["body.json is not JSON"]);
  } finally {
    s.done();
  }
});

test("cleanup waits for an adoption in flight, and keeps the run from the moment the attach was asked", async () => {
  let answer!: (r: Response) => void;
  const s = setup(() => new Promise<Response>((r) => (answer = r)));
  try {
    const adoption = s.homes.adopt(RUN, "u8");
    await new Promise((r) => setImmediate(r));
    assert.equal(s.homes.handed, "d1-u8", "asked, not answered: the server may hold it already");
    let closed = false;
    const closing = s.homes.close().then(() => void (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, false, "cleanup does not go on while the attach is unanswered");
    answer(Response.json({ link: "/run/d1-u8#secret" }));
    await adoption;
    await closing;
    assert.equal(s.homes.handed, "d1-u8");
    await assert.rejects(s.homes.adopt({ ...RUN, id: "d1-u9" }, "u9"), /cleaning up/);
    assert.equal(s.asked.length, 1, "no adoption starts once cleanup began");
  } finally {
    s.done();
  }
});

test("a server that answers no gives the run back; one that never answers leaves it handed", async () => {
  const refused = setup(() => Promise.resolve(Response.json({ error: "held elsewhere" }, { status: 409 })));
  try {
    await assert.rejects(refused.homes.adopt(RUN, "u8"), /did not adopt d1-u8: 409 held elsewhere/);
    assert.equal(refused.homes.handed, undefined);
    assert.equal(refused.homes.home, undefined);
  } finally {
    refused.done();
  }
  const silent = setup(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
  try {
    await assert.rejects(silent.homes.adopt(RUN, "u8"), /timeout/);
    assert.equal(silent.homes.handed, "d1-u8");
  } finally {
    silent.done();
  }
});
