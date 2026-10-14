// archilControl: one disk's control API from an API key, exported for a library caller that composes its own supervisor
// (with daytonaHost, or a driver of its own), and the same object the CLI's supervisor builds for itself. A fake `disk`
// client stands in for Archil, so nothing here reaches the network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { archilControl as fromRoot } from "../src/index.ts";
import { archilControl, type DiskClient } from "../src/supervise.ts";
import { cliControl } from "../src/cli.ts";

const METHODS = ["getObject", "headObject", "putObject", "addUser", "removeUser", "listDelegations", "revokeDelegation", "exec", "listObjects", "deleteObjects"] as const;

/** A `disk` client whose disk records every call and answers with its own name; `authorizedUsers` grows on each read. */
function fakeClient() {
  const calls: unknown[][] = [];
  let reads = 0;
  const disk = Object.fromEntries(METHODS.map((m) => [m, async (...args: unknown[]) => (calls.push([m, ...args]), `${m} answered`)]));
  const client = {
    configure: (options: unknown) => void calls.push(["configure", options]),
    getDisk: async (id: string) => {
      calls.push(["getDisk", id]);
      reads++;
      return { ...disk, authorizedUsers: Array.from({ length: reads }, (_, i) => ({ identifier: `u${i}` })) };
    },
  } as unknown as DiskClient;
  return { client, calls };
}

describe("archilControl", () => {
  it("is exported from the package root", () => {
    assert.equal(fromRoot, archilControl);
  });

  it("configures the client with the key and region, opens the disk, and passes each call through to it", async () => {
    const { client, calls } = fakeClient();
    const control = await archilControl({ apiKey: "k-not-real", disk: "dsk-0001", region: "aws-us-east-1", client });
    assert.deepEqual(calls.splice(0), [["configure", { apiKey: "k-not-real", region: "aws-us-east-1" }], ["getDisk", "dsk-0001"]]);
    assert.deepEqual(Object.keys(control).sort(), [...METHODS, "listUsers"].sort());
    assert.equal(await control.getObject("runs/r1/run.json"), "getObject answered");
    await control.removeUser("token", "u-1");
    await control.listObjects("runs/r1/", { recursive: true });
    assert.deepEqual(calls.splice(0), [["getObject", "runs/r1/run.json"], ["removeUser", "token", "u-1"], ["listObjects", "runs/r1/", { recursive: true }]]);
    // listUsers reads the disk record again on every call: the user list lags, so a stale snapshot would hide users.
    assert.deepEqual(await control.listUsers(), [{ identifier: "u0" }, { identifier: "u1" }]);
    assert.deepEqual(await control.listUsers(), [{ identifier: "u0" }, { identifier: "u1" }, { identifier: "u2" }]);
  });

  it("the CLI's supervisor builds the same object from its flags and the key's variable", async () => {
    const variable = "PDA_TEST_ARCHIL_KEY";
    process.env[variable] = "k-from-env";
    try {
      const cli = fakeClient();
      const library = fakeClient();
      const fromCli = await cliControl({ "api-key-env": variable, disk: "dsk-0002", region: "aws-us-west-2" }, cli.client);
      const fromLibrary = await archilControl({ apiKey: "k-from-env", disk: "dsk-0002", region: "aws-us-west-2", client: library.client });
      assert.deepEqual(Object.keys(fromCli).sort(), Object.keys(fromLibrary).sort());
      assert.deepEqual(cli.calls, library.calls, "the same configure and getDisk calls");
      await fromCli.listDelegations();
      assert.deepEqual(cli.calls.at(-1), ["listDelegations"]);
    } finally {
      delete process.env[variable];
    }
  });

  it("the CLI refuses without the key, naming the variable", async () => {
    await assert.rejects(cliControl({ "api-key-env": "PDA_TEST_NO_SUCH_KEY", disk: "dsk-0003", region: "aws-us-east-1" }, fakeClient().client), /no API key in \$PDA_TEST_NO_SUCH_KEY/);
  });
});
