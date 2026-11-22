// The learning folder over code.storage (learn/code-storage.ts), against its in-memory fake
// (fixtures/code-storage-fake.mjs): the shared suite (learn-folder-suite.mjs), each case on a fresh repository.
import { generateKeyPairSync } from "node:crypto";
import { codeStorageLearningStore } from "../dist/learn/code-storage.js";
import { codeStorageFake } from "./fixtures/code-storage-fake.mjs";
import { folderSuite } from "./learn-folder-suite.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const key = privateKey.export({ type: "pkcs8", format: "pem" });
let n = 0;

folderSuite("code.storage", async () => {
  const fake = codeStorageFake({ name: "example-org", publicKey });
  return codeStorageLearningStore({ name: "example-org", key, apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => `srv${++n}` }, "agent-one");
});
