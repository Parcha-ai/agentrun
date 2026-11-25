// The names the computer package hands a child it starts (the docker CLI, the local browser's supervisor and Chrome) of
// the environment serve passes it: none is a name serve holds as a key's (secret-name.ts' keyShaped, the one rule the
// run environment's cut uses), so no list hands a child a key, or a pointer to one, that serve keeps from its runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as computer from "@parcha/agentrun-computer";
import { keyShaped } from "../dist/secret-name.js";

const LISTS = ["DOCKER_ENV_NAMES", "CHROME_ENV_NAMES", "ADB_ENV_NAMES"];

test("no name the computer package hands docker or Chrome of serve's environment is shaped like a key", () => {
  for (const list of LISTS) {
    const names = computer[list];
    assert.ok(Array.isArray(names) && names.length > 0, `@parcha/agentrun-computer exports no ${list}, the names it hands that child`);
    assert.deepEqual(names.filter((name) => keyShaped(name)), [], `${list} hands a child a key-shaped name`);
  }
});
