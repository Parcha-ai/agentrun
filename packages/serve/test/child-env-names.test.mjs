// The names of serve's environment the computer package's providers are handed (each descriptor's hostEnv, which serve
// reads by name and passes as the provider's `env`) and hand their children (the docker CLI, the local browser's
// supervisor and Chrome, adb): every one survives serve's own cut of a child's environment (secrets.ts withoutSecrets:
// the launcher's secret names, and every name shaped as a key's). A by-name read gets past the environment's
// non-enumerable secrets, so a list that named one would hand it over; this holds that no list does, whether the name is
// shaped as a key's or not.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as computer from "@parcha/agentrun-computer";
import { keyShaped } from "../dist/secret-name.js";
import { SECRET_NAMES, withoutSecrets } from "../dist/secrets.js";

test("no name a computer provider is handed of serve's environment, or hands a child of it, is one serve keeps from a child", () => {
  const lists = [
    ...computer.PROVIDERS.filter((entry) => entry.hostEnv).map((entry) => [`${entry.id}'s hostEnv`, entry.hostEnv]),
    ...["BASE_ENV_NAMES", "DOCKER_ENV_NAMES", "CHROME_ENV_NAMES"].map((list) => [list, computer[list]]),
  ];
  for (const [what, names] of lists) {
    assert.ok(Array.isArray(names) && names.length > 0, `@parcha/agentrun-computer gives no ${what}`);
    assert.deepEqual(names.filter((name) => !(name in withoutSecrets({ [name]: "x" }))), [], `${what} names a variable serve keeps from a child`);
  }
});

test("the cut the lists are held to catches a secret whose name is not shaped as a key's", () => {
  const plain = SECRET_NAMES.filter((name) => !keyShaped(name));
  assert.ok(plain.length > 0, "the launcher names a secret that is not key-shaped (its store's URL)");
  for (const name of plain) assert.equal(name in withoutSecrets({ [name]: "x" }), false, `${name} survives the cut`);
});
