// A door's proof that it is the one its host launched: POST /door-proof answers a challenge with the nonce the host handed
// the process (`run --door-nonce-fd`), from the moment the door listens, and behind its bearer token like every route.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { doorProof, serveRun } from "../src/serve.ts";

const ask = (url: string, body: unknown, token = "tok") =>
  fetch(new URL("/door-proof", url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /door-proof", () => {
  it("answers a challenge with the nonce, before any run is attached; refuses a bad challenge and a missing token", async () => {
    const nonce = "d".repeat(64);
    const server = await serveRun({ port: 0, token: "tok", proof: nonce });
    try {
      const challenge = "0123456789abcdef0123456789abcdef";
      const res = await ask(server.url, { challenge });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { proof: doorProof(nonce, challenge) });
      assert.equal((await ask(server.url, { challenge: "not hex" })).status, 400);
      assert.equal((await ask(server.url, { challenge }, "wrong")).status, 401);
    } finally {
      await server.close();
    }
  });

  it("is no route on a door given no nonce", async () => {
    const server = await serveRun({ port: 0, token: "tok" });
    try {
      assert.equal((await ask(server.url, { challenge: "0123456789abcdef" })).status, 404);
    } finally {
      await server.close();
    }
  });
});
