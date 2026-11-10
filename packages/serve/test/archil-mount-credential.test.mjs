// The Archil mount credential (serve/src/workspace/archil-mount-credential.ts): minted per run at Archil's control API
// with the account key, removed by its identifier (idempotent), its ttl the run's lifetime bound; neither the token nor
// the key ever in the environment, an argument, a log line or an error. Against a loopback fake of the control API
// only: no call leaves this machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mintMountToken, removeMountToken, ttlOf } from "../dist/workspace/archil-mount-credential.js";
import { archilControlFake } from "./archil-control-fake.mjs";

const KEY = "fake-test-key-archil-account-0001";
const DISK = "dsk-0000000000000001";

async function control(t, options) {
  const fake = await archilControlFake(options);
  t.after(() => fake.close());
  return { fake, options: { disk: DISK, region: "aws-us-east-1", key: () => KEY, baseUrl: fake.baseUrl } };
}

test("mint: a token user on the disk, named for the run, with the run's lifetime bound as its ttl, under the account key", async (t) => {
  const { fake, options } = await control(t);
  const credential = await mintMountToken(options, { nickname: "agentrun run-1", ttlMs: 90 * 60_000 });
  assert.deepEqual(credential, { token: "fake-minted-token-1", identifier: "tok-1" });
  assert.deepEqual(fake.requests, [{ method: "POST", path: `/api/disks/${DISK}/users`, query: {}, authorization: `Bearer ${KEY}`, body: { type: "token", nickname: "agentrun run-1", ttl: "5400s" } }]);
});

test("the ttl is the run's lifetime bound in whole seconds, never a fixed hour", () => {
  assert.equal(ttlOf(24 * 60 * 60_000), "86400s");
  assert.equal(ttlOf(1500), "2s");
  assert.equal(ttlOf(0), "1s");
  assert.equal(ttlOf(400 * 24 * 60 * 60_000), "31536000s", "at most Archil's 365 days");
});

test("the run's earlier claims' token users are removed by nickname (agentrun:<run>:<epoch>); its own epoch's, another run's and a person's stay", async (t) => {
  const { fake, options } = await control(t, {
    existing: [
      { identifier: "a", nickname: "agentrun:run-1:1" },
      { identifier: "b", nickname: "agentrun:run-1:3" },
      { identifier: "c", nickname: "agentrun:run-10:1" },
      { identifier: "d", nickname: "agentrun:run-1:x" },
      { identifier: "e", nickname: "someone's mount" },
    ],
  });
  const { removeOlderMountTokens, nicknameOf } = await import("../dist/workspace/archil-mount-credential.js");
  assert.equal(nicknameOf("run-1", 3), "agentrun:run-1:3");
  assert.deepEqual(await removeOlderMountTokens(options, "run-1", 3), ["a"]);
  assert.deepEqual([...fake.users.keys()].sort(), ["b", "c", "d", "e"]);
});

test("remove: by its identifier; removed twice is still removed (a 404 is already gone)", async (t) => {
  const { fake, options } = await control(t);
  const { identifier } = await mintMountToken(options, { nickname: "agentrun run-1", ttlMs: 60_000 });
  await removeMountToken(options, identifier);
  await removeMountToken(options, identifier);
  assert.deepEqual(fake.requests.slice(1).map((one) => [one.method, one.path, one.query.identifier, one.authorization]), [
    ["DELETE", `/api/disks/${DISK}/users/token`, "tok-1", `Bearer ${KEY}`],
    ["DELETE", `/api/disks/${DISK}/users/token`, "tok-1", `Bearer ${KEY}`],
  ]);
  assert.equal(fake.users.size, 0);
});

test("a refusal is in words, and neither the key nor the token is in it, the environment, the arguments or a log line", async (t) => {
  const TOKEN = "fake-minted-token-1";
  const { options } = await control(t, {
    answer: ({ method }) => ({ status: 500, body: { error: `boom: the key ${KEY} and the token ${TOKEN} were in the server's words (${method})` } }),
  });
  const logged = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const name of ["log", "error", "warn"]) console[name] = (...args) => logged.push(args.join(" "));
  const envBefore = JSON.stringify(process.env);
  try {
    const minting = await mintMountToken(options, { nickname: "agentrun run-1", ttlMs: 60_000 }).then(() => undefined, (error) => error);
    assert.match(minting.message, /Archil refused to mint the run's mount credential \(500\)/);
    const removing = await removeMountToken(options, "tok-1", { token: TOKEN }).then(() => undefined, (error) => error);
    assert.match(removing.message, /Archil refused to remove the run's mount credential \(500\)/);
    // A failed mint has no token of the run's to leak: its key is scrubbed. A remove knows the run's token: both are.
    assert.ok(!minting.message.includes(KEY) && !String(minting.stack).includes(KEY), `scrubbed: ${minting.message}`);
    assert.ok(!removing.message.includes(KEY) && !removing.message.includes(TOKEN), `scrubbed: ${removing.message}`);
    assert.ok(!String(removing.stack).includes(KEY) && !String(removing.stack).includes(TOKEN));
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(JSON.stringify(process.env), envBefore, "nothing put in the environment");
  assert.ok(!process.argv.join(" ").includes(KEY), "nothing in the arguments");
  assert.deepEqual(logged, [], "nothing logged");
});

test("a control plane that is not https is refused, except on this machine's loopback", async () => {
  await assert.rejects(mintMountToken({ disk: DISK, region: "aws-us-east-1", key: () => KEY, baseUrl: "http://control.example.com" }, { nickname: "n", ttlMs: 1000 }), /must be https/);
  await assert.rejects(mintMountToken({ disk: DISK, region: "nowhere-1", key: () => KEY }, { nickname: "n", ttlMs: 1000 }), /no control plane for region "nowhere-1"/);
});

test("the run's users removed by name: one remove that fails (a network blip) leaves none after it standing, and the error names the one that failed", async (t) => {
  let first = true;
  const { fake, options } = await control(t, {
    existing: [
      { identifier: "a", nickname: "agentrun:run-1:1" },
      { identifier: "b", nickname: "agentrun:run-1:2" },
      { identifier: "c", nickname: "agentrun:run-1:3" },
      { identifier: "d", nickname: "agentrun:run-1:4" },
      { identifier: "e", nickname: "agentrun:run-2:1" },
    ],
    // The first remove is refused, as a blip would; every other one goes through.
    answer: ({ method }) => {
      if (method !== "DELETE" || !first) return undefined;
      first = false;
      return { status: 503, body: { error: "the control plane is busy" } };
    },
  });
  const { removeRunMountTokens } = await import("../dist/workspace/archil-mount-credential.js");
  await assert.rejects(removeRunMountTokens(options, "run-1", 3), (error) => {
    assert.match(error.message, /run run-1's token users a \(.*\) were not removed; 2 others were/);
    assert.ok(!error.message.includes(KEY), "the key is in no error");
    return true;
  });
  assert.deepEqual([...fake.users.keys()].sort(), ["a", "d", "e"], "b and c removed after a's failed; the later epoch's and another run's stay");
  assert.equal(fake.requests.filter((one) => one.method === "DELETE").length, 3, "each of the three tried once");
});
