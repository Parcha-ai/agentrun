// The runner's GitHub App access (runner/github-app.ts): the App's id and private key read from the store's trigger_settings
// rows (sealed as sealed-settings-store.ts seals them) at each claim, bound into the mint the claim step calls, with the
// run's repository from its first input: the GitHub event's payload tag, else the first github.com repository its owner
// names. No App, a row that does not open, or no seal key: no access.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { seal } from "@parcha/pi-durable-agent";
import { storeOn } from "./store-helpers.mjs";

const { githubAppAccess } = await import("../dist/runner/github-app.js");

const KEY = randomBytes(32);
const { privateKey: PEM } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

/** The App's rows, sealed under `key` as the server's sealed settings write them. */
async function connected(store, { key = KEY, appId = "4242", pem = PEM } = {}) {
  for (const [field, value] of [["app_id", appId], ["private_key", pem], ["slug", "agentrun-test-app"]]) {
    await store.triggerSettings.put({ adapter: "github", scope: "server", field, sealed: seal(key, Buffer.from(value, "utf8"), `trigger_settings|github|server|${field}`).toString("base64") });
  }
}

/** A fake GitHub that makes installation 777's token for one repository, and knows acme/widgets's installation. */
async function fakeGitHub(t) {
  const asked = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      asked.push({ method: req.method, url: req.url, body, iss: JSON.parse(Buffer.from(String(req.headers.authorization).split(".")[1] ?? "", "base64url").toString() || "{}").iss });
      const answer = (status, doc) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(doc));
      if (req.url === "/repos/acme/widgets/installation") return answer(200, { id: 777 });
      if (req.method === "POST" && req.url === "/app/installations/777/access_tokens") return answer(201, { token: "not-a-secret-ghs-token", expires_at: "2026-11-08T06:00:00Z" });
      return answer(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { api: `http://127.0.0.1:${server.address().port}`, asked };
}

test("a run started by a GitHub event mints for the event's installation and repository, with the App read from the store", async (t) => {
  const { store } = await storeOn(t);
  await connected(store);
  const github = await fakeGitHub(t);
  const content = 'Review it.\n\n<trigger-payload source="github" installation="777" repo="acme/widgets" number="7">{}</trigger-payload>';
  const access = await githubAppAccess(store, KEY, { content }, { api: github.api });
  assert.deepEqual(access.target, { installation: 777, repo: "acme/widgets" });
  assert.deepEqual(await access.mint(access.target), { ok: true, token: "not-a-secret-ghs-token", expires_at: Date.parse("2026-11-08T06:00:00Z") });
  assert.deepEqual(github.asked.map((a) => [a.method, a.url, a.iss]), [["POST", "/app/installations/777/access_tokens", 4242]]);
  assert.deepEqual(JSON.parse(github.asked[0].body), { repositories: ["widgets"] }, "narrowed to the run's one repository");
});

test("a run started by hand names its repository in its owner's words; GitHub says which installation covers it", async (t) => {
  const { store } = await storeOn(t);
  await connected(store);
  const github = await fakeGitHub(t);
  const access = await githubAppAccess(store, KEY, { content: "Review https://github.com/acme/widgets/pull/7 please." }, { api: github.api });
  assert.deepEqual(access.target, { repo: "acme/widgets" });
  assert.equal((await access.mint(access.target)).ok, true);
  assert.deepEqual(github.asked.map((a) => a.url), ["/repos/acme/widgets/installation", "/app/installations/777/access_tokens"]);
});

test("no App the runner can open is no access: never connected, no seal key, or rows sealed under another key", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await githubAppAccess(store, KEY, { content: "https://github.com/acme/widgets" }), undefined, "never connected");
  await connected(store, { key: randomBytes(32) });
  assert.equal(await githubAppAccess(store, KEY, { content: "https://github.com/acme/widgets" }), undefined, "another key's rows");
  assert.equal(await githubAppAccess(store, undefined, { content: "https://github.com/acme/widgets" }), undefined, "no seal key");
});

test("a run that names no repository has access with no target: the claim step refuses its calls in words", async (t) => {
  const { store } = await storeOn(t);
  await connected(store);
  const access = await githubAppAccess(store, KEY, { content: "Say hello." });
  assert.equal(access.target, undefined);
});
