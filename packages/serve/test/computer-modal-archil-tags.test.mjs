// A Mode 2 run on Modal through the server's own composition: computerForClaim with the server's spec (computerSpecOf),
// the run's labels and its Archil folder (archilWorkspace's mountSpec), on the computer package's ModalProvider, over the
// slice of Modal's SDK as a recorder: it keeps the tags sandboxes.create is handed, and refuses the create, so no sandbox
// is made. Modal holds a sandbox's tags to 512 bytes: qa36's live run was refused there ("a sandbox's cumulative tags
// size (533 bytes) cannot exceed 512 bytes") for an agent id of 20 characters; this one has the longest an agent may
// have (agents-store.ts ID_PATTERN, 128) and a run id of a run's shape (a UUID).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { labelsOf, ModalProvider } from "../../computer/dist/modal.js";
import { putSealedKey } from "../dist/server-keys.js";
import { archilWorkspace, computerForClaim } from "../dist/workspace/index.js";
import { computerSpecOf } from "../dist/workspace/computer-deps.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { readBackOf } from "./fixtures/archil-readback.mjs";
import { storeOn } from "./store-helpers.mjs";
import { ARCHIL_KINDS } from "./workspace-kinds-fixture.mjs";

const RUN = "01a1d0b9-3e8b-7352-9497-a407e2909f53";
const AGENT = "a".repeat(128);
const TOKEN = `tok-${randomBytes(16).toString("hex")}`;

/** The SDK's slice as a recorder: the app, an image, an empty listing, and a create it keeps the params of and refuses. */
function recorder() {
  const created = [];
  const image = { dockerfileCommands: () => image };
  const sdk = {
    apps: { fromName: async (name) => ({ appId: `ap-${name}` }) },
    images: { fromRegistry: () => image, fromId: async () => image },
    sandboxes: {
      create: async (_app, _image, params) => {
        created.push(params);
        throw Object.assign(new Error("400: refused by the test's recorder"), { name: "InvalidError" });
      },
      fromId: async () => {
        throw Object.assign(new Error("Sandbox not found"), { name: "NotFoundError" });
      },
      list: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
  };
  return { sdk, created };
}

const DIR = mkdtempSync(join(tmpdir(), "serve-modal-tags-"));
const DAEMON_PATH = join(DIR, "computerd-linux-amd64");
writeFileSync(DAEMON_PATH, "a stand-in for computerd\n");
test.after(() => rmSync(DIR, { recursive: true, force: true }));

test("a Modal sandbox with the run's Archil folder, for the longest agent id, is asked for within Modal's 512 bytes of tags", async (t) => {
  const { store } = await storeOn(t);
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "MODAL_TOKEN_ID", "fake-test-modal-token-id-0001");
  await putSealedKey(store, sealKey, "MODAL_TOKEN_SECRET", "fake-test-modal-token-secret-0001");
  const sdk = recorder();
  const disk = new FakeArchilDisk();
  const workspace = archilWorkspace(disk, `agents/${AGENT}/runs/${RUN}/work`, { region: "aws-us-east-1", mountToken: async () => TOKEN });
  const answer = await computerForClaim({ runId: RUN, epoch: 1, computer: { kind: "sandbox", provider: "modal" } }, store, {
    mode: 2, kinds: ARCHIL_KINDS, sealKey,
    providers: { modal: async ({ app }) => new ModalProvider({ sdk: sdk.sdk, app, daemonPath: DAEMON_PATH }) },
    spec: computerSpecOf({}),
    workspace, check: { readBackOf, epoch: 1 },
  });
  t.after(() => answer.release?.());
  assert.equal(sdk.created.length, 1, `the provider asked Modal for one sandbox: ${JSON.stringify(answer).replaceAll(TOKEN, "[token]")}`);
  const [{ tags }] = sdk.created;
  const bytes = Object.entries(tags).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
  assert.ok(bytes <= 512, `${bytes} bytes of tags`);
  assert.equal(tags["agentrun.run"], RUN);
  assert.equal(JSON.parse(labelsOf(tags)["agentrun.mount"]).folder, `agents/${AGENT}/runs/${RUN}/work`, "the run's folder, as the tags record it");
  assert.ok(!JSON.stringify(tags).includes(TOKEN), "no tag holds the token");
});
