// A writer for workspace-local.test.mjs's durability tests, run with pi-durable-disk's fsync-snapshot shim preloaded.
// It works through LocalWorkspace (`port`), through LocalWorkspace attached to a fake computer that binds the folder
// and writes it with plain node:fs, never syncing (`attached`), or through plain node:fs (`plain`, the red), prints
// "returned" once every call returned, and SIGKILLs itself.
//   workspace-durable-writer.mjs <port|attached|plain> <root>   a file three folders down, and two appends to a log
//   workspace-durable-writer.mjs <port|attached|plain>-remove <root>   removes gone.txt, sub/gone.txt and the tree tree/
import { appendFile, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { localWorkspace } from "../../dist/workspace/index.js";
import { fakeComputer } from "../workspace-fake-computer.mjs";

const [how, root] = process.argv.slice(2);
const FILE = "deep/er/file.bin";
const bytes = Buffer.alloc(1024 * 1024 + 3);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
const workspaceFor = async (kind) => (kind === "attached" ? localWorkspace(root).attach(fakeComputer(root)) : localWorkspace(root));

if (how === "port" || how === "attached") {
  const workspace = await workspaceFor(how);
  await workspace.write(FILE, bytes);
  await workspace.append("log/run.log", "first\n");
  await workspace.append("log/run.log", "second\n");
} else if (how === "plain") {
  await mkdir(dirname(join(root, FILE)), { recursive: true });
  await writeFile(join(root, FILE), bytes);
  await mkdir(join(root, "log"), { recursive: true });
  await appendFile(join(root, "log/run.log"), "first\n");
  await appendFile(join(root, "log/run.log"), "second\n");
} else if (how === "port-remove" || how === "attached-remove") {
  const workspace = await workspaceFor(how.slice(0, -"-remove".length));
  await workspace.remove("gone.txt");
  await workspace.remove("sub/gone.txt");
  await workspace.remove("tree", { recursive: true });
} else if (how === "plain-remove") {
  await unlink(join(root, "gone.txt"));
  await unlink(join(root, "sub/gone.txt"));
  await rm(join(root, "tree"), { recursive: true });
} else {
  throw new Error(`usage: workspace-durable-writer.mjs <port|plain>[-remove] <root>, not ${how}`);
}
process.stdout.write("returned\n", () => process.kill(process.pid, "SIGKILL"));
