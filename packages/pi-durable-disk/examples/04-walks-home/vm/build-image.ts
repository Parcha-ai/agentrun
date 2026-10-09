// Build (or find, Modal caches by content) the demo's VM image and print its id: `node build-image.ts [--app NAME]`.
// `--print-commands` prints the recipe instead (no Modal needed). The id goes to `serve.ts --cloud-module ... --cloud-arg image=IM`; D2's GPU image composes `vmImageCommands` (image.ts) on top of the training image.
// MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in the environment.
import { parseArgs } from "node:util";
import { ModalClient } from "modal";
import { vmImageCommands } from "./image.ts";

const { values } = parseArgs({
  options: {
    app: { type: "string", default: "pda-demo" },
    base: { type: "string", default: "ubuntu:24.04" },
    // The commands as a JSON array, for a builder in another language (`Image.dockerfile_commands(json.loads(...))`).
    "print-commands": { type: "boolean", default: false },
    "no-archil": { type: "boolean", default: false },
    desktop: { type: "boolean", default: false },
    uid: { type: "string" },
    gid: { type: "string" },
  },
});
const uid = values.uid ? Number(values.uid) : process.getuid!();
const gid = values.gid ? Number(values.gid) : process.getgid!();
if (values["print-commands"]) {
  console.log(JSON.stringify(vmImageCommands(uid, gid, { archil: !values["no-archil"], desktop: values.desktop })));
  process.exit(0);
}
const modal = new ModalClient();
const app = await modal.apps.fromName(values.app!, { createIfMissing: true });
const t0 = Date.now();
const image = await modal.images.fromRegistry(values.base!).dockerfileCommands(vmImageCommands(uid, gid, { archil: !values["no-archil"], desktop: values.desktop })).build(app);
console.log(JSON.stringify({ imageId: image.imageId, app: values.app, base: values.base, ms: Date.now() - t0 }));
