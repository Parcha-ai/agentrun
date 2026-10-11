// The leak check, checked. The scanner finds each sentinel in every form it claims to, is green on clean data with
// coverage in every source, and is red on a value planted at every place a run writes; the limits checker is red on each
// limit and green within them. The sweep over the package's functions is only worth as much as this suite.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { resolveLimits } from "@parcha/pi-vision";
import {
  LeakScan, SENTINELS, SENTINEL_EYES_KEY, SENTINEL_LINK_QUERY, SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, SENTINEL_SIGNED_LINK,
  fixtureDir, leakNeedles, limitViolations, pngBytes, signedLink,
} from "@parcha/pi-vision/testing";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

test("the sentinels are obviously fake, long enough to find a head or a tail, distinct, and a link carries its secrets in its query", () => {
  const values = Object.values(SENTINELS);
  assert.deepEqual(Object.keys(SENTINELS), ["eyesKey", "linkSignature", "linkToken"]);
  for (const value of values) assert.ok(value.length >= 32 && value.startsWith("pv-sentinel-"), value);
  assert.equal(new Set(values).size, values.length);
  for (const a of values) for (const b of values) assert.ok(a === b || !a.includes(b), "no sentinel holds another");
  const url = new URL(SENTINEL_SIGNED_LINK);
  assert.equal(url.hostname, "files.sentinel.invalid");
  assert.equal(url.searchParams.get("X-Sentinel-Signature"), SENTINEL_LINK_SIGNATURE);
  assert.equal(url.searchParams.get("token"), SENTINEL_LINK_TOKEN);
  assert.equal(SENTINEL_LINK_QUERY, url.search.slice(1));
  assert.ok(!SENTINEL_SIGNED_LINK.includes(SENTINEL_EYES_KEY));
  assert.ok(signedLink("a/b.pdf").startsWith("https://files.sentinel.invalid/a/b.pdf?"));
});

// The forms are planted a second way here, so a scanner that quietly stopped matching one turns this red.
const planted = (value) => ({
  raw: `a ${value} b`,
  "url-encoded": `?q=${encodeURIComponent(value)}&x=1`,
  json: JSON.stringify({ k: `p${value}s` }),
  hex: `00${Buffer.from(value).toString("hex")}ff`,
  head: `${value.slice(0, 24)} and no more`,
  tail: `and no more ${value.slice(-24)}`,
  ...Object.fromEntries([0, 1, 2].flatMap((k) => ["base64", "base64url"].map((encoding) => [`${encoding}+${k}`, Buffer.from(`${"-".repeat(k)}${value}!!`).toString(encoding)]))),
});

test("the scanner sees every sentinel in every form it checks, and nothing that only looks like one", () => {
  let forms = 0;
  for (const [name, value] of Object.entries(SENTINELS)) {
    for (const [form, text] of Object.entries(planted(value))) {
      forms++;
      const scan = new LeakScan({ [name]: value });
      scan.value("probe", text);
      assert.ok(scan.findings.some((f) => f.sentinel === name), `${name} as ${form}`);
    }
    const near = new LeakScan(SENTINELS);
    near.value("probe", [`X${value.slice(1, -1)}Y`, value.slice(0, 15), value.slice(-15), value.toUpperCase()]);
    assert.equal(near.report(), "no sentinel found", `${name}: a near miss is not a leak`);
  }
  assert.equal(forms, 3 * 12);
  const held = leakNeedles(SENTINEL_EYES_KEY).map((n) => n.form);
  for (const form of ["raw", "hex", "base64+0", "base64+1", "base64+2", "head", "tail"]) assert.ok(held.includes(form), form);
});

const record = (extra = {}) => ({
  tool: "look",
  args: { path: "filing.pdf", ask: "what is the total?", page: 3, model: "fake-eyes", native: false, ...extra.args },
  status: "ok",
  facts: { sha256: "ab".repeat(32), kind: "pdf", fragment: "page=3", shown: "page 3 at 150 dpi", fit: { reduction: "as_is" }, key: "cd".repeat(32), derived: ["page-3-150dpi-ab12cd34.png"], ...extra.facts },
  body: extra.body ?? "The total is 1,234.",
});
const cleanResult = () => ({ content: [{ type: "text", text: "original 1500x2000, shown 1500x2000" }, { type: "image", data: b64(pngBytes(8, 8)), mimeType: "image/png" }], details: { kind: "image", shown: 1 }, isError: false });

test("green on clean data, with coverage in every source", async () => {
  const dir = await fixtureDir("pi-vision-leaks-");
  try {
    await dir.file("derived/page-3-150dpi-ab12cd34.png", pngBytes(4, 4));
    const scan = new LeakScan();
    scan.value("result", cleanResult());
    scan.value("details", cleanResult().details);
    scan.value("receipt", record());
    scan.value("memo", { key: `vision:look:${"ef".repeat(32)}`, value: { text: "The total is 1,234.", model: "fake-eyes" } });
    scan.value("error", Object.assign(new Error("the eyes failed"), { request: { headers: { accept: "application/json" } } }));
    scan.names("derived-names", ["page-3-150dpi-ab12cd34.png"]);
    scan.dir("derived", dir.path);
    assert.equal(scan.report(), "no sentinel found");
    assert.ok(scan.clean());
    for (const source of ["result", "details", "receipt", "memo", "error"]) assert.ok(scan.covered(source).records > 0 && scan.covered(source).bytes > 0, `${source} covered`);
    assert.ok(scan.covered("derived-names").records === 1 && scan.covered("derived").bytes > 0);
    scan.dir("missing", `${dir.path}/not-there`);
    assert.deepEqual(scan.covered("missing"), { bytes: 0, records: 0 });
  } finally { await dir.remove(); }
});

const pngWithText = (secret) => {
  const png = Buffer.from(pngBytes(4, 4));
  const body = Buffer.from(`Comment\0${secret}`);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write("tEXt", 4, "latin1");
  // A text chunk before IEND; the scanner reads bytes, so the chunk's checksum does not matter here.
  return Buffer.concat([png.subarray(0, png.length - 12), head, body, Buffer.alloc(4), png.subarray(png.length - 12)]);
};
const loop = (secret) => { const a = { note: secret }; a.self = a; return a; };

/** Where a leak lands: the source the scan must report it under, and how it is planted. */
const PLANTS = {
  "a result's text": ["result", (scan, v) => scan.value("result", { ...cleanResult(), content: [{ type: "text", text: `see ${v}` }] })],
  "a result's details": ["result", (scan, v) => scan.value("result", { ...cleanResult(), details: { via: { link: v } } })],
  "an error result": ["result", (scan, v) => scan.value("result", { content: [{ type: "text", text: `fetch ${v} refused` }], isError: true })],
  "a result's image metadata": ["result", (scan, v) => scan.value("result", { content: [{ type: "image", data: b64(pngWithText(v)), mimeType: "image/png" }] })],
  "a receipt's answer": ["receipt", (scan, v) => scan.value("receipt", record({ body: `The total is ${v}` }))],
  "a receipt's source path": ["receipt", (scan, v) => scan.value("receipt", record({ args: { path: `statement.pdf?x=${v}` } }))],
  "a receipt's derived list": ["receipt", (scan, v) => scan.value("receipt", record({ facts: { derived: [`page-${v}.png`] } }))],
  "a receipt written as JSON text": ["receipt", (scan, v) => scan.value("receipt", JSON.stringify({ header: { args: { note: v } } }))],
  "a memo's key": ["memo", (scan, v) => scan.value("memo", { key: `vision:look:${v}`, value: { text: "ok" } })],
  "a memo's value": ["memo", (scan, v) => scan.value("memo", { key: "vision:look:k", value: { text: "ok", via: v } })],
  "a derived name": ["derived-names", (scan, v) => scan.names("derived-names", [`page-1-${v}.png`])],
  "an error's own property": ["error", (scan, v) => scan.value("error", Object.assign(new Error("failed"), { request: { headers: { authorization: `Bearer ${v}` } } }))],
  "an error's cause": ["error", (scan, v) => scan.value("error", new Error("failed", { cause: new Error(`dial ${v}`) }))],
  "an error's stack": ["error", (scan, v) => scan.value("error", Object.assign(new Error("failed"), { stack: `Error: failed\n    at fetch (${v})` }))],
  "a structure that holds itself": ["result", (scan, v) => scan.value("result", loop(v))],
};

for (const [name, secret] of Object.entries(SENTINELS)) {
  for (const [note, [source, plant]] of Object.entries(PLANTS)) {
    test(`red on ${name} planted in ${note}`, () => {
      const scan = new LeakScan();
      plant(scan, secret);
      const found = scan.findings.filter((f) => f.sentinel === name);
      assert.ok(found.length > 0 && found.every((f) => f.source === source), scan.report());
      assert.ok(!scan.clean() && scan.report().includes(`${name} (`) && /@\d+/.test(scan.report()));
    });
  }
}

test("red on a planted leak in a derived directory: in a file's name, and in its bytes", async () => {
  const dir = await fixtureDir("pi-vision-leaks-");
  try {
    await mkdir(`${dir.path}/page-cache`);
    await writeFile(`${dir.path}/page-cache/${SENTINEL_LINK_SIGNATURE}.png`, pngBytes(2, 2));
    await writeFile(`${dir.path}/page-cache/notes.txt`, `prefix ${SENTINEL_EYES_KEY} suffix`);
    await dir.file("clean.txt", "nothing here");
    const scan = new LeakScan();
    scan.dir("derived", dir.path);
    const at = (sentinel) => scan.findings.filter((f) => f.sentinel === sentinel).map((f) => f.where);
    assert.deepEqual(at("linkSignature").map((w) => w.replace(/@\d+$/, "")), ["name:page-cache/pv-sentinel-sig-0d4b9e71a3c85f26e8b7c4a1593d60f2.png"]);
    assert.deepEqual(at("eyesKey"), ["page-cache/notes.txt@7"]);
    assert.deepEqual(at("linkToken"), []);
  } finally { await dir.remove(); }
});

test("each secret part of a signed link is found alone, and the link whole finds both", () => {
  for (const [name, part] of [["linkSignature", SENTINEL_LINK_SIGNATURE], ["linkToken", SENTINEL_LINK_TOKEN]]) {
    const scan = new LeakScan();
    scan.value("result", { content: [{ type: "text", text: `saved as report.pdf?sig=${part}` }] });
    assert.deepEqual(scan.findings.map((f) => f.sentinel), [name]);
  }
  const whole = new LeakScan();
  whole.value("result", SENTINEL_SIGNED_LINK);
  assert.deepEqual(whole.findings.map((f) => f.sentinel).sort(), ["linkSignature", "linkToken"]);
  const origin = new LeakScan();
  origin.value("result", "https://files.sentinel.invalid/reports/statement.pdf?X-Sentinel-Expires=1790000000&page=2");
  assert.equal(origin.report(), "no sentinel found", "the origin, path and expiry are no secret");
});

test("a sentinel allowed on a source is not a finding there, and is one everywhere else", () => {
  const scan = new LeakScan(SENTINELS, { linkSignature: ["echo:"], linkToken: ["echo:"] });
  scan.value("echo:citation", `${SENTINEL_SIGNED_LINK}#page=3`);
  assert.ok(scan.clean(), "the link may come back where it went in");
  scan.value("echo:citation", `${SENTINEL_EYES_KEY}`);
  scan.value("result", SENTINEL_SIGNED_LINK);
  assert.deepEqual(scan.findings.map((f) => [f.sentinel, f.source]), [["eyesKey", "echo:citation"], ["linkSignature", "result"], ["linkToken", "result"]]);
});

test("a scan can look for a set of its own", () => {
  const scan = new LeakScan({ custom: "a-value-this-test-made-up-for-itself-0123" });
  scan.value("result", `${SENTINEL_EYES_KEY} and a-value-this-test-made-up-for-itself-0123`);
  assert.deepEqual(scan.findings.map((f) => f.sentinel), ["custom"]);
});

const png = (width, height, fill) => ({ type: "image", data: b64(pngBytes(width, height, fill)), mimeType: "image/png" });
const noise = (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y) % 256];
const text = { type: "text", text: "original 1500x900" };

test("the limits checker: green within the limits, on the edge of each, and on a result with no media", () => {
  const limits = resolveLimits(undefined);
  assert.deepEqual(limitViolations({ content: [text] }, limits), []);
  assert.deepEqual(limitViolations({ content: [text, png(1500, 900)] }, limits), []);
  assert.deepEqual(limitViolations({ content: [png(2000, 1), png(1, 2000)] }, limits), [], "exactly the edge is within it");
  assert.deepEqual(limitViolations({ content: Array.from({ length: limits.imagesPerCall }, () => png(4, 4)) }, limits), [], "exactly the count is within it");
});

test("the limits checker: red on an edge over, an image over its bytes, too many images, and too many bytes in all", () => {
  const limits = resolveLimits(undefined);
  assert.match(limitViolations({ content: [text, png(2001, 10)] }, limits).join("\n"), /content\[1\]: 2001x10, over 2000x2000/);
  assert.match(limitViolations({ content: [png(10, 2001)] }, limits).join("\n"), /content\[0\]: 10x2001, over 2000x2000/);
  const heavy = png(40, 40, noise);
  assert.ok(heavy.data.length > 100);
  assert.deepEqual(limitViolations({ content: [heavy] }, { ...limits, image: { ...limits.image, maxBytes: 100 } }).map((v) => v.replace(/\d+ base64/, "N base64")), [`content[0]: N base64 bytes, over 100`]);
  assert.match(limitViolations({ content: Array.from({ length: limits.imagesPerCall + 1 }, () => png(4, 4)) }, limits).join("\n"), /^9 images, over 8 a call$/);
  const share = { ...limits, requestBytes: 1000 };
  assert.ok(heavy.data.length > 250);
  assert.match(limitViolations({ content: [heavy] }, share).join("\n"), /image bytes, over 250 \(the result's share of the request body\)/);
  assert.equal(limitViolations({ content: [png(2001, 10), ...Array.from({ length: 8 }, () => png(4, 4))] }, limits).length, 2, "each limit is reported");
});

test("the limits checker: a video block only on a route that takes video and within its inline bytes; anything it cannot measure is over", () => {
  const limits = resolveLimits(undefined);
  const clip = (bytes) => ({ type: "image", data: b64(Buffer.alloc(bytes, 1)), mimeType: "video/mp4" });
  assert.match(limitViolations({ content: [clip(100)] }, limits).join("\n"), /a video block on a route that takes no video/);
  const native = { ...limits, video: { native: true, inlineBytes: 1000 } };
  assert.deepEqual(limitViolations({ content: [clip(1000)] }, native), []);
  assert.deepEqual(limitViolations({ content: [clip(1001)] }, native), ["content[0]: 1001 video bytes, over 1000"]);
  const webp = { type: "image", data: b64(Buffer.from("RIFF0000WEBPVP8 ")), mimeType: "image/webp" };
  assert.match(limitViolations({ content: [webp] }, limits).join("\n"), /the size of this image\/webp is not readable from its header/);
  assert.match(limitViolations({ content: [{ type: "image", data: b64(Buffer.from("%PDF-1.7")), mimeType: "application/pdf" }] }, limits).join("\n"), /application\/pdf is neither an image nor a video/);
  assert.match(limitViolations({ content: [{ type: "image", data: "", mimeType: "image/png" }] }, limits).join("\n"), /not readable/);
});
