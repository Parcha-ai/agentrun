// The learning folder's script over the fake Archil disk (fixtures/archil-fake.mjs, #1968): the shared suite
// (learn-folder-suite.mjs), the folder at an agent's learning key, every write one exec of the script there.
import * as workspace from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { folderSuite } from "./learn-folder-suite.mjs";

let n = 0;
folderSuite("archil", async () => ({ ws: workspace.archilWorkspace(new FakeArchilDisk(), `agents/acme-0123456789abcdef/learning${n++ ? `-${n}` : ""}`) }));
