// The records an import has read are indexed by packed keys: shorter than the reader's, and one-to-one, so a record is
// a copy exactly when the reader's own key says so.
import assert from "node:assert/strict";
import { test } from "node:test";
import { packed, packInto } from "../dist/record-key.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, parseHome, tempHome, writeJsonl } from "./fixtures.mjs";

const UUID = "0f1e2d3c-4b5a-4697-8877-665544332211";
/** `key` packed, as bytes of its own. */
const packKey = (key) => {
  const { bytes, length } = packInto(key, packed());
  return bytes.slice(0, length);
};

test("a uuid's key packs to its 16 bytes, a message's to six bits a char", () => {
  const uuid = packKey(`u:${UUID}`);
  assert.equal(uuid.length, 17);
  assert.equal(uuid[0], 1);
  assert.equal(Buffer.from(uuid.subarray(1)).toString("hex"), UUID.replaceAll("-", ""));
  const message = `m:msg_01AbCdEfGhIjKlMnOpQrStUv:req_011CUaBcDeFgHiJkLmNoPqRsTu`;
  assert.equal(packKey(message).length, 1 + Math.ceil((message.length * 6) / 8));
});

test("no two keys pack the same", () => {
  const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
  const keys = new Set([
    `u:${UUID}`,
    `u:${UUID.toUpperCase()}`,
    `u:${UUID.replaceAll("-", "_")}`,
    `u:${UUID.replaceAll("-", ":")}`,
    `u:${UUID}x`,
    `U:${UUID}`,
    UUID,
    `l:${UUID}`,
    // The packed uuid's own bytes, and the packed message's, as keys: packed as any other.
    latin1(packKey(`u:${UUID}`)),
    latin1(packKey("m:msg_1:req_1")),
    "m:msg_1:req_1",
    "m:msg_1:req_10",
    "m:msg_1:req_1A",
    "m:msg_1:req_1:",
    "m:msg_1:req_",
    "",
    "0",
    "00",
    "000",
    "0000",
    "A",
    ":",
    "\0",
    "\0\0",
    "\u0001",
    "\u0100",
    "\u0001\u0000",
    "m:msg_é:req_1",
    "m:msg_日本:req_1",
    "\ud800",
    "\udc00",
    "x".repeat(5000),
    "x".repeat(4096),
  ]);
  // Every length mod 4 and a trailing letter of value 0 (padding bits): each its own.
  for (let n = 0; n < 12; n += 1) keys.add("0".repeat(n)).add(`${"0".repeat(n)}1`).add(`${"z".repeat(n)}`);
  const packed = new Map();
  for (const key of keys) {
    const at = latin1(packKey(key));
    assert.equal(packed.get(at), undefined, `${JSON.stringify(key)} packs as ${JSON.stringify(packed.get(at))} does`);
    packed.set(at, key);
  }
  assert.equal(packed.size, keys.size);
});

test("Claude Code: a record is a copy exactly when its uuid or request key is one another file read", async (t) => {
  const home = await tempHome(t);
  const upper = UUID.toUpperCase();
  await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000a"), [
    claudeUser({ uuid: UUID, text: "First.", i: 0 }),
    claudeAnswer({ uuid: "1f1e2d3c-4b5a-4697-8877-665544332211", msg: "msg_01AbC", req: "req_011X", usage: anthropicUsage(10, 1), i: 1 }),
  ]);
  // Its copies (the same uuid, the same message and request) count nothing; a uuid in capitals or a request id that
  // differs only in its last letter is another record.
  await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000b"), [
    claudeUser({ uuid: UUID, text: "First.", i: 0 }),
    claudeAnswer({ uuid: "2f1e2d3c-4b5a-4697-8877-665544332211", msg: "msg_01AbC", req: "req_011X", usage: anthropicUsage(10, 1), i: 1 }),
    claudeUser({ uuid: upper, text: "Second.", i: 2 }),
    claudeAnswer({ uuid: "3f1e2d3c-4b5a-4697-8877-665544332211", msg: "msg_01AbC", req: "req_011Y", usage: anthropicUsage(100, 2), i: 3 }),
    claudeAnswer({ uuid: "4f1e2d3c-4b5a-4697-8877-665544332211", msg: "msg_01AbD", req: "req_011X", usage: anthropicUsage(1000, 3), i: 4 }),
  ]);
  const sessions = await parseHome(home, { sources: ["claude-code"], catalog: false });
  const byInput = sessions.map(({ tokens, calls, turns }) => [tokens.input, calls, turns]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(byInput, [
    [10, 1, 1],
    [1100, 2, 1],
  ]);
});
