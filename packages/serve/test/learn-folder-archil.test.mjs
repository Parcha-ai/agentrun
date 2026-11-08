// The learning folder's script over the fake Archil disk (fixtures/archil-fake.mjs, #1968): the shared suite
// (learn-folder-suite.mjs), the folder at an agent's learning key, every write one exec of the script there. Skipped
// with a reason where the Archil backend is not on this branch yet.
import { existsSync } from "node:fs";
import { test } from "node:test";
import * as workspace from "../dist/workspace/index.js";
import { folderSuite } from "./learn-folder-suite.mjs";

const fake = new URL("./fixtures/archil-fake.mjs", import.meta.url);
const { FakeArchilDisk } = existsSync(fake) ? await import(fake.href) : {};

if (!workspace.archilWorkspace || !FakeArchilDisk) {
  test("archil: the shared suite over the fake disk", { skip: "the Archil backend (serve/src/workspace/archil.ts and test/fixtures/archil-fake.mjs, #1968) is not on this branch yet" }, () => {});
} else {
  let n = 0;
  folderSuite("archil", async () => ({ ws: workspace.archilWorkspace(new FakeArchilDisk(), `agents/acme-0123456789abcdef/learning${n++ ? `-${n}` : ""}`) }));
}
