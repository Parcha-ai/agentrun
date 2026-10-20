// The file a transcription is made from reaches ffprobe, which finds its length, as a path: a name that starts with a
// dash is a file and not an option, and a name with a colon is not an address.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { tmp } from "./durable/rig.mjs";

const mp3 = () => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(4096, 0x55)]);
const WORDS = [{ text: "Tranquility", start: 3.06, end: 3.7 }];

test("a recording named like an option or an address is measured by ffprobe as a path", async () => {
  const cwd = tmp("vision-transcribe-paths-");
  const names = ["-h.mp3", "a:b.mp3"];
  for (const name of names) fs.writeFileSync(path.join(cwd, name), mp3());
  const real = nodeVisionEnv({ cwd });
  const argv = [];
  const env = { ...real, exec: (command, options, context) => { argv.push([...command]); return real.exec(command, options, context); } };
  const vision = createVisionExtension({ transcriber: { provider: "fake", model: "fake-stt", usdPerMinute: 0.006, transcribe: async () => ({ words: WORDS, text: "Tranquility" }) }, evidence: { file: async (label) => ({ path: `evidence/${label}/1.md` }) }, scope: () => ({ label: "hear", deriveDir: ".vision" }) });
  const call = { conversationId: "c", callId: "1", memo: async (_, compute) => compute() };
  for (const name of names) await vision.transcribe(env, call).execute({ path: name });
  const probes = argv.filter((command) => command[0] === "ffprobe");
  assert.deepEqual(probes.map((command) => command.at(-1)), names.map((name) => `./${name}`));
});
