#!/usr/bin/env node
// What the check of a binary payload filed whole costs (mcp-gateway.ts binaryKept): one image's data, by default at the
// most of an answer the gateway reads (mcp-wire.ts MAX_RESPONSE, as base64), against a runner's redactor holding a full set of keys
// of the shapes and lengths runners hold, made here from random bytes (no key is real). On demand, never on a PR:
// nothing here fails on time. It prints the median of each step over the runs, and how many random payloads of that
// size the shape check withholds by chance. --size sets the payload's base64 length in MiB; --whole also times the held
// values read over every byte, which binaryKept does not do. Run it from packages/serve after a build:
//   node scripts/mcp-binary-scan-bench.mjs [--runs 5] [--values 32] [--chance 20] [--size 4] [--whole]
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { binaryKept, textRuns } from "../dist/mcp-gateway.js";
import { MAX_RESPONSE } from "../dist/mcp-wire.js";
import { secretShapes, valueLeft } from "../dist/learn/secrets.js";
import { heldRedactor, secretRedactor } from "../dist/runner/redact.js";

const { values: args } = parseArgs({ options: { runs: { type: "string", default: "5" }, values: { type: "string", default: "32" }, chance: { type: "string", default: "20" }, size: { type: "string" }, whole: { type: "boolean", default: false } } });
const runs = Number(args.runs);
const count = Number(args.values);
const chances = Number(args.chance);
const size = args.size ? Math.floor((Number(args.size) * 1024 * 1024) / 4) * 4 : MAX_RESPONSE;

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** `length` random characters of `alphabet`. */
const of = (alphabet, length) => Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
const b64url = (text) => Buffer.from(text).toString("base64url");
/** The shapes a runner holds, each made anew: model keys, tool keys, cloud and chat tokens, a signed token, hex secrets,
 *  passwords. Their prefixes are joined here so no line of this file reads as a key. */
const SHAPES = [
  () => `${"sk"}-proj-${of(`${ALNUM}-_`, 156)}`,
  () => `${"sk"}-ant-api03-${of(`${ALNUM}-_`, 95)}`,
  () => `${"sk"}-or-v1-${randomBytes(32).toString("hex")}`,
  () => `${"gh"}p_${of(ALNUM, 36)}`,
  () => `${"gh"}s_${of(ALNUM, 36)}`,
  () => `${"github"}_pat_${of(`${ALNUM}_`, 82)}`,
  () => `${"AK"}IA${of(UPPER, 16)}`,
  () => of(`${ALNUM}+/`, 40),
  () => `${"AI"}za${of(`${ALNUM}_-`, 35)}`,
  () => `${"xo"}xb-${of("0123456789", 12)}-${of("0123456789", 13)}-${of(ALNUM, 24)}`,
  () => [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(JSON.stringify({ sub: of(ALNUM, 24), exp: 2_000_000_000 })), randomBytes(32).toString("base64url")].join("."),
  () => randomBytes(20).toString("hex"),
  () => randomBytes(32).toString("hex"),
  () => randomBytes(24).toString("base64"),
  () => of(`${ALNUM}!@#%^&*`, 20),
  () => `${"whsec"}_${randomBytes(24).toString("base64")}`,
];
const held = Array.from({ length: count }, (_, i) => SHAPES[i % SHAPES.length]());

const redact = heldRedactor(secretRedactor(held.slice(0, Math.ceil(count / 2))));
redact.hold(held.slice(Math.ceil(count / 2)));
const values = redact.heldValues();
const clean = (text) => redact(text);
const own = (text) => text;

/** An image's data: random bytes (as compressed image data reads) whose base64 is `size` characters. */
const payload = () => randomBytes((size / 4) * 3).toString("base64");

const median = (times) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
const timed = (work) => {
  const started = performance.now();
  const out = work();
  return { ms: performance.now() - started, out };
};

const steps = { decode: [], "text runs": [], "shapes (text runs)": [], "held values (base64)": [], "held values (text runs)": [], ...(args.whole ? { "held values (every byte)": [] } : {}), "binaryKept, whole": [] };
let runChars = 0;
let kept = 0;
for (let run = 0; run < runs; run++) {
  const data = payload();
  const decode = timed(() => Buffer.from(data, "base64").toString("latin1"));
  steps.decode.push(decode.ms);
  const text = timed(() => textRuns(decode.out));
  steps["text runs"].push(text.ms);
  runChars += text.out.length;
  steps["shapes (text runs)"].push(timed(() => secretShapes(text.out)).ms);
  steps["held values (base64)"].push(timed(() => valueLeft(data, values, [])).ms);
  steps["held values (text runs)"].push(timed(() => valueLeft(text.out, values, [])).ms);
  if (args.whole) steps["held values (every byte)"].push(timed(() => valueLeft(decode.out, values, [])).ms);
  const whole = timed(() => binaryKept(data, clean, own, values));
  steps["binaryKept, whole"].push(whole.ms);
  if (whole.out === data) kept++;
}

const byChance = { base64: 0, text: 0 };
for (let one = 0; one < chances; one++) {
  const data = payload();
  if (secretShapes(data).length) byChance.base64++;
  if (secretShapes(textRuns(Buffer.from(data, "base64").toString("latin1"))).length) byChance.text++;
}

console.log(`payload: ${size} base64 characters (${(size / 4) * 3} bytes, ${Math.round(runChars / runs)} characters of text runs), ${values.length} held values (lengths ${Math.min(...values.map((v) => v.length))}-${Math.max(...values.map((v) => v.length))}), ${runs} runs, node ${process.version}`);
for (const [step, times] of Object.entries(steps)) console.log(`  ${step.padEnd(26)} median ${median(times).toFixed(1)} ms   (${times.map((ms) => ms.toFixed(0)).join(", ")})`);
console.log(`  kept whole: ${kept} of ${runs}`);
console.log(`withheld by chance by a shape, of ${chances} random payloads: read in the base64 text ${byChance.base64}, read in the bytes' text runs ${byChance.text}`);
