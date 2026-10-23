// The verify skill's two steps run as written: each ```js block of skills/verify/SKILL.md runs in pi-codemode's sandbox
// with a `bash` tool over a workspace the test builds and the handle's `vision.judge`. The documents are drawn: a page's
// kind is a coloured band across its top, and each mark is a shape of its own colour (a red seal, a blue signature, an
// orange file number of bars, a purple authentication block, a green stamp holding the file number's bars). The fake Jev
// looks at the pixels it is sent: the colour a question names is there or not, its box is where those pixels are, and two
// numbers are the same when they have as many bars. Needs pdftoppm, ffmpeg and ffprobe: `npm run test:binaries` runs it,
// `npm test` does not.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { imageHeader } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fixtureDir } from "@parcha/pi-vision/testing";
import { USD_PER_MTOK } from "../support/jev.mjs";

const SKILL = fs.readFileSync(new URL("../../skills/verify/SKILL.md", import.meta.url), "utf8");
const [pagesStep, marksStep, ...more] = [...SKILL.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
const [example] = [...SKILL.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
const TASK = 'const task = { document: "certificate.pdf", checklist: "checklist.json" };';

const PALETTE = {
  navy: [20, 30, 110], teal: [0, 140, 140], red: [220, 30, 30], blue: [30, 70, 230], orange: [250, 150, 0],
  purple: [140, 40, 170], green: [20, 170, 60], grey: [110, 110, 110], white: [255, 255, 255],
};
const rgb = (name) => `rgb(${PALETTE[name].join(",")})`;
/** The palette colour a pixel is, or null when it is near none of them. */
function colourOf(r, g, b) {
  let best = null;
  let distance = 60;
  for (const [name, [pr, pg, pb]] of Object.entries(PALETTE)) {
    const d = Math.hypot(r - pr, g - pg, b - pb);
    if (d < distance) [best, distance] = [name, d];
  }
  return best;
}

// A Letter page drawn at 150 dpi: 1275 x 1650 pixels for 612 x 792 points.
const W = 1275;
const H = 1650;
const BARS = (x, y, n) => Array.from({ length: n }, (_, i) => `<rect x="${x + i * 50}" y="${y}" width="30" height="40" fill="${rgb("orange")}"/>`).join("");
const LINES = Array.from({ length: 12 }, (_, i) => `<rect x="150" y="${300 + i * 60}" width="${900 - (i % 3) * 120}" height="14" fill="${rgb("grey")}"/>`).join("");
/** Where each mark is drawn, in pixels of the page: left, top, right, bottom. */
const AT = { seal: [547, 1310, 727, 1490], signature: [850, 1290, 1150, 1370], file_number: [150, 1450, 280, 1490], authentication: [850, 1440, 1150, 1500], stamp: [800, 150, 1150, 330] };
const MARKS = {
  seal: `<circle cx="637" cy="1400" r="90" fill="${rgb("red")}"/>`,
  signature: `<polyline points="850,1370 900,1290 950,1370 1000,1290 1050,1370 1100,1290 1150,1370" fill="none" stroke="${rgb("blue")}" stroke-width="12" stroke-linejoin="round"/>`,
  file_number: (bars) => BARS(150, 1450, bars),
  authentication: `<rect x="850" y="1440" width="300" height="60" fill="${rgb("purple")}"/>`,
  stamp: (bars) => `<rect x="806" y="156" width="338" height="168" fill="none" stroke="${rgb("green")}" stroke-width="12"/>${BARS(900, 220, bars)}`,
};
const band = (colour) => `<rect x="0" y="60" width="${W}" height="60" fill="${rgb(colour)}"/>`;
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${LINES}${body}</svg>`);

/** The three pages of a drawn certificate: the certification page, the filed page and a page of text. `marks: false`
 *  draws neither marks nor stamp (the kinds stay); the stamp's number has `stampBars` bars and the page's `bars`. */
const certificate = ({ marks = true, bars = 3, stampBars = bars } = {}) => [
  svg(`${band("navy")}${marks ? `${MARKS.seal}${MARKS.signature}${MARKS.file_number(bars)}${MARKS.authentication}` : ""}`),
  svg(`${band("teal")}${marks ? MARKS.stamp(stampBars) : ""}`),
  svg(""),
];

/** A PDF of one JPEG a page, each drawn over a Letter media box; `cropBox` (points: left, bottom, right, top) is the part
 *  a viewer shows. Every xref offset is measured from the bytes written. */
async function pdf(pages, { cropBox } = {}) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids = [];
  for (const page of pages) {
    const jpeg = await sharp(page).jpeg({ quality: 95 }).toBuffer();
    const image = objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]));
    const draw = "q 612 0 0 792 0 0 cm /Im1 Do Q";
    const content = objects.push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    kids.push(objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${cropBox ? ` /CropBox [${cropBox.join(" ")}]` : ""} /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let at = chunks[0].length;
  for (const [i, body] of objects.entries()) {
    offsets.push(at);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    at += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

const CHECKLIST = {
  document: "A drawn certificate",
  pages: { certification: "A page with a navy band across its top.", filed: "A page with a teal band across its top." },
  marks: [
    { id: "seal", page: "certification", mark: "The seal", present: "A red disc at the foot of the page.", question: "Is there a red seal in `images[0].image`?", box: "the red seal in `images[0].image`" },
    { id: "signature", page: "certification", mark: "The signature", present: "A blue zigzag at the bottom right.", question: "Is there a blue signature in `images[0].image`?", box: "the blue signature in `images[0].image`" },
    { id: "file_number", page: "certification", mark: "The file number", present: "Orange bars at the bottom left.", question: "Is there an orange file number in `images[0].image`?", box: "the orange file number in `images[0].image`" },
    { id: "authentication", page: "certification", mark: "The authentication block", present: "A purple block at the bottom right.", question: "Is there a purple authentication block in `images[0].image`?", box: "the purple authentication block in `images[0].image`" },
    { id: "stamp", page: "filed", mark: "The FILED stamp", present: "A green frame at the top right.", question: "Is there a green stamp in `images[0].image`?", box: "the green stamp in `images[0].image`" },
    { id: "numbers_match", same: ["file_number", "stamp"], mark: "The file numbers agree", present: "As many orange bars in both.", question: "Is the orange number in `images[0].image` the same as the orange number in `images[1].image`?" },
  ],
};

/** The pixels of an image by palette colour: how many, and the box of each as fractions of the sides. */
async function colours(bytes) {
  const { data, info } = await sharp(Buffer.from(bytes)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const seen = {};
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3;
    const name = colourOf(data[i], data[i + 1], data[i + 2]);
    if (!name || name === "white" || name === "grey") continue;
    const s = (seen[name] ??= { n: 0, left: x, top: y, right: x, bottom: y });
    s.n++; s.left = Math.min(s.left, x); s.right = Math.max(s.right, x); s.top = Math.min(s.top, y); s.bottom = Math.max(s.bottom, y);
  }
  const box = (s) => ({ left: s.left / info.width, right: (s.right + 1) / info.width, top: s.top / info.height, bottom: (s.bottom + 1) / info.height });
  return { seen: Object.fromEntries(Object.entries(seen).filter(([, s]) => s.n >= 50).map(([name, s]) => [name, { n: s.n, box: box(s) }])), data, info };
}
/** The orange bars across the middle of an image's orange: how many runs a row through them crosses. */
function bars({ seen, data, info }) {
  const orange = seen.orange;
  if (!orange) return 0;
  const y = Math.round(((orange.box.top + orange.box.bottom) / 2) * info.height);
  let runs = 0;
  let inside = false;
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3;
    const now = colourOf(data[i], data[i + 1], data[i + 2]) === "orange";
    if (now && !inside) runs++;
    inside = now;
  }
  return runs;
}
const named = (text) => Object.keys(PALETTE).find((name) => new RegExp(`\\b${name}\\b`).test(text));

/** A Jev port that answers from the pixels it is sent. */
function pixelJev({ tweak = (_key, _q, answer) => answer } = {}) {
  const requests = [];
  const judge = async (params) => {
    const images = await Promise.all(params.state.images.map((image) => colours(params.assets[image.image].bytes)));
    requests.push({ sources: params.state.images.map((image) => image.source), sizes: params.state.images.map((image) => imageHeader(params.assets[image.image].bytes)), questions: params.questions });
    const [first] = images;
    const answers = Object.fromEntries(Object.entries(params.questions).map(([key, q]) => {
      if (q.type === "choice") {
        const kind = Object.entries(q.criteria).find(([, text]) => { const c = named(text); return c && (first.seen[c]?.n ?? 0) >= 500; })?.[0] ?? "other";
        return [key, { type: "choice", choice: kind, confidence: 0.9 }];
      }
      if (q.type === "noul" && images.length === 2) return [key, { type: "noul", noul: bars(images[0]) > 0 && bars(images[0]) === bars(images[1]) ? 0.95 : 0.05 }];
      const found = first.seen[named(q.instructions)];
      if (q.type === "noul") return [key, { type: "noul", noul: found ? 0.95 : 0.04 }];
      return [key, { type: "box", box: found?.box ?? { top: 0, bottom: 1, left: 0, right: 1 }, confidence: found ? 0.9 : 0.1 }];
    }));
    for (const [key, q] of Object.entries(params.questions)) answers[key] = tweak(key, q, answers[key]);
    return { answers, model: params.model, usage: { input_tokens: 1000, output_tokens: 0 }, cost_usd: (1000 * USD_PER_MTOK) / 1e6 };
  };
  return { judge, requests };
}

const dir = await fixtureDir("pi-vision-verify-skill-");
after(() => dir.remove());
const cwd = dir.path;
const write = (name, bytes) => fs.writeFileSync(path.join(cwd, name), bytes);
write("checklist.json", JSON.stringify(CHECKLIST));
write("certificate.pdf", await pdf(certificate()));

/** A bash tool as a host's code mode gives one: the command's output, or a rejection whose message names the exit code
 *  and holds the output. */
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd, maxBuffer: 1 << 26 }, (error, stdout, stderr) => (error ? reject(new Error(`the command exited with code ${error.code ?? 1}:\n${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)))) };

/** Runs the steps in order, each in a sandbox of its own over the same workspace and the same Jev. */
async function steps(codes, { jev = pixelJev(), fails = false } = {}) {
  const filed = [];
  const vision = createVisionExtension({ jev: { judge: jev.judge }, evidence: { file: async (_label, record) => { filed.push(record); return { path: `receipts/${filed.length}.json` }; } }, scope: () => ({ label: "verify", deriveDir: ".vision" }) });
  const values = [];
  for (const [i, code] of codes.entries()) {
    const call = { conversationId: "verify", callId: String(i + 1), model: undefined, signal: undefined };
    const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.judge(nodeVisionEnv({ cwd }), call)] });
    try {
      const ran = await sandbox.execute(code);
      if (fails) { values.push(ran.ok ? ran.value : ran.error); continue; }
      assert.ok(ran.ok, ran.ok ? "" : ran.error.message);
      values.push(ran.value);
    } finally { await sandbox.close(); }
  }
  return { values, jev, filed };
}
const withTask = (code, task) => { const out = code.replace(TASK, task); assert.notEqual(out, code, "the step opens with the task line"); return out; };
const percent = ([left, top, right, bottom], width = W, height = H) => [(left / width) * 100, (top / height) * 100, ((right - left) / width) * 100, ((bottom - top) / height) * 100];
const xywh = (fragment) => fragment.split("xywh=percent:")[1].split(",").map(Number);
const near = (got, want, by, what) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= by, `${what}: ${got} is not within ${by} of ${want.map((n) => n.toFixed(2))}`));
const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));

test("the skill holds the two steps this test runs, each opening with the task line, and a checklist that reads", () => {
  assert.deepEqual([typeof pagesStep, typeof marksStep, more], ["string", "string", []]);
  for (const code of [pagesStep, marksStep]) assert.ok(code.startsWith(TASK), "a step's first line is the task");
  const list = JSON.parse(example);
  assert.ok(Object.keys(list.pages).length > 0);
  for (const mark of list.marks) {
    assert.match(mark.id, /^[a-z0-9_]+$/);
    assert.ok(mark.mark && mark.present && mark.question, `${mark.id} says what it is, what it looks like and its question`);
    assert.ok(mark.page ? list.pages[mark.page] && mark.box : mark.same.every((id) => list.marks.some((m) => m.id === id)), `${mark.id} sits on a page kind with a box, or names two marks`);
  }
});

test("a document with every mark: each page's kind, every mark yes with its box on its page, the numbers checked side by side", async () => {
  const { values: [kinds, verdict], jev, filed } = await steps([pagesStep, marksStep]);
  assert.deepEqual(kinds, [{ page: 1, kind: "certification" }, { page: 2, kind: "filed" }, { page: 3, kind: "other" }]);
  const rows = byId(verdict.rows);
  assert.equal(verdict.every, true);
  assert.deepEqual(verdict.rows.map((row) => [row.id, row.value]), CHECKLIST.marks.map((mark) => [mark.id, "yes"]));
  for (const id of ["seal", "signature", "file_number", "authentication"]) {
    assert.equal(rows[id].cites.length, 1);
    assert.match(rows[id].cites[0].fragment, /^certificate\.pdf#page=1&xywh=percent:/);
    near(xywh(rows[id].cites[0].fragment), percent(AT[id]), 1.5, id);
    assert.equal(rows[id].note, CHECKLIST.marks.find((mark) => mark.id === id).present);
  }
  assert.match(rows.stamp.cites[0].fragment, /^certificate\.pdf#page=2&xywh=percent:/);
  near(xywh(rows.stamp.cites[0].fragment), percent(AT.stamp), 1.5, "stamp");
  assert.deepEqual(rows.numbers_match.cites.map((cite) => cite.fragment), [rows.file_number.cites[0].fragment, rows.stamp.cites[0].fragment], "both boxes, on their two pages");
  assert.deepEqual(rows.seal.cites[0].receipts, ["receipts/1.json"], "a row cites the receipt of the look that saw it");
  assert.equal(jev.requests.length, 4, "one request a page, one for the numbers");
  assert.deepEqual(jev.requests.slice(0, 3).map((r) => r.sources), [["certificate.pdf#page=1"], ["certificate.pdf#page=2"], ["certificate.pdf#page=3"]]);
  assert.deepEqual(Object.keys(jev.requests[0].questions), ["kind", "seal", "seal_at", "signature", "signature_at", "file_number", "file_number_at", "authentication", "authentication_at", "stamp", "stamp_at"]);
  assert.deepEqual(jev.requests[0].sizes.map(({ width, height }) => [width, height]), [[850, 1100]], "a Letter page at 100 dpi, through its crop box");
  const numbers = jev.requests[3];
  assert.equal(numbers.sources.length, 2);
  for (const size of numbers.sizes) assert.ok(Math.min(size.width, size.height) >= 280 && Math.max(size.width, size.height) <= 1568, `a cut-out within Jev's sides: ${size.width}x${size.height}`);
  assert.match(verdict.table, /^\| Mark \| There \| Where \|\n\|---\|---\|---\|\n\| The seal \| yes \| certificate\.pdf#page=1&xywh=percent:/);
  assert.equal(filed.length, 4);
  assert.ok(fs.existsSync(path.join(cwd, ".verify", "certificate.pdf", "marks.json")));
});

test("the same document with its marks taken out: every mark no, no box drawn, each row citing the page it was looked for on", async () => {
  write("certificate.pdf", await pdf(certificate({ marks: false })));
  const { values: [kinds, verdict], jev } = await steps([pagesStep, marksStep]);
  assert.deepEqual(kinds.map((k) => k.kind), ["certification", "filed", "other"], "the pages keep their kinds");
  assert.equal(verdict.every, false);
  assert.deepEqual(verdict.rows.map((row) => [row.id, row.value]), CHECKLIST.marks.map((mark) => [mark.id, "no"]));
  const rows = byId(verdict.rows);
  for (const id of ["seal", "signature", "file_number", "authentication"]) assert.deepEqual(rows[id].cites.map((c) => c.fragment), ["certificate.pdf#page=1"], `${id}: Jev's box is dropped`);
  assert.deepEqual(rows.stamp.cites.map((c) => c.fragment), ["certificate.pdf#page=2"]);
  assert.deepEqual(rows.numbers_match.cites, [{ fragment: "certificate.pdf#page=1", receipts: ["receipts/1.json"] }, { fragment: "certificate.pdf#page=2", receipts: ["receipts/2.json"] }], "each part's page with the look that found nothing there");
  assert.deepEqual(rows.seal.cites, [{ fragment: "certificate.pdf#page=1", receipts: ["receipts/1.json"] }]);
  assert.equal(rows.numbers_match.note, "file_number and stamp not there");
  assert.match(rows.seal.note, /^not there: /);
  assert.equal(jev.requests.length, 3, "nothing to compare: no request for the numbers");
  assert.match(verdict.table, /\| The seal \| no \| certificate\.pdf#page=1 \|/);
});

test("a mark that is there with a box Jev could not place on the page: yes, citing its page; a comparison that needs it is a no, citing each part's page and look", async () => {
  write("certificate.pdf", await pdf(certificate({ marks: false }).map((page, i) => (i ? page : svg(`${band("navy")}${MARKS.file_number(3)}`)))));
  // A box of no size names no region: vision.judge gives its answer with no fragment.
  const jev = pixelJev({ tweak: (key, _q, answer) => (key === "file_number_at" ? { ...answer, box: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } } : answer) });
  const { values: [, verdict] } = await steps([pagesStep, marksStep], { jev });
  const rows = byId(verdict.rows);
  assert.equal(rows.file_number.value, "yes");
  assert.deepEqual(rows.file_number.cites, [{ fragment: "certificate.pdf#page=1", receipts: ["receipts/1.json"] }]);
  assert.equal(rows.numbers_match.value, "no");
  assert.equal(rows.numbers_match.note, "stamp not there; file_number without a box");
  assert.deepEqual(rows.numbers_match.cites, [{ fragment: "certificate.pdf#page=1", receipts: ["receipts/1.json"] }, { fragment: "certificate.pdf#page=2", receipts: ["receipts/2.json"] }]);
  assert.equal(jev.requests.length, 3, "nothing to compare");
});

test("file numbers that differ: every mark yes but the numbers' row, which cites the two pages and no box", async () => {
  write("certificate.pdf", await pdf(certificate({ bars: 3, stampBars: 4 })));
  const { values: [, verdict], jev } = await steps([pagesStep, marksStep]);
  const rows = byId(verdict.rows);
  assert.deepEqual(verdict.rows.filter((row) => row.value === "no").map((row) => row.id), ["numbers_match"]);
  assert.deepEqual(rows.numbers_match.cites.map((c) => c.fragment), ["certificate.pdf#page=1", "certificate.pdf#page=2"]);
  assert.equal(jev.requests.length, 4);
});

test("a page with a crop box smaller than its media box: the box is in percent of the crop box, the page a viewer shows", async () => {
  // The crop box takes 90 points off the left, 36 off the bottom and 18 off the right and the top.
  const crop = [90, 36, 594, 774];
  write("certificate.pdf", await pdf(certificate(), { cropBox: crop }));
  const { values: [, verdict], jev } = await steps([pagesStep, marksStep]);
  assert.deepEqual(jev.requests[0].sizes.map(({ width, height }) => [width, height]), [[700, 1025]], "504 x 738 points at 100 dpi");
  const [l, t, r, b] = AT.seal.map((v, i) => (i % 2 ? v * (792 / H) : v * (612 / W)));
  const shown = [l - crop[0], t - (792 - crop[3]), r - crop[0], b - (792 - crop[3])];
  const seal = xywh(byId(verdict.rows).seal.cites[0].fragment);
  near(seal, percent(shown, crop[2] - crop[0], crop[3] - crop[1]), 1.5, "seal in the crop box");
  assert.ok(Math.abs(seal[0] - percent(AT.seal)[0]) > 5, "and not where it sits on the media box");
});

test("another kind of document is another checklist file and another file name", async () => {
  write("ticket.json", JSON.stringify({
    document: "A drawn ticket",
    pages: { front: "A page with a teal band across its top." },
    marks: [
      { id: "stamp", page: "front", mark: "The stamp", present: "A green frame.", question: "Is there a green stamp in `images[0].image`?", box: "the green stamp in `images[0].image`" },
      { id: "seal", page: "front", mark: "The seal", present: "A red disc.", question: "Is there a red seal in `images[0].image`?", box: "the red seal in `images[0].image`" },
    ],
  }));
  write("my ticket.pdf", await pdf([svg(`${band("teal")}${MARKS.stamp(2)}`)]));
  const task = 'const task = { document: "my ticket.pdf", checklist: "ticket.json" };';
  const { values: [kinds, verdict], jev } = await steps([withTask(pagesStep, task), withTask(marksStep, task)]);
  assert.deepEqual(kinds, [{ page: 1, kind: "front" }]);
  assert.deepEqual(verdict.rows.map((row) => [row.id, row.value, row.cites.map((c) => c.fragment.split("&")[0])]), [["stamp", "yes", ["my ticket.pdf#page=1"]], ["seal", "no", ["my ticket.pdf#page=1"]]]);
  assert.deepEqual(Object.keys(jev.requests[0].questions), ["kind", "stamp", "stamp_at", "seal", "seal_at"]);
  assert.ok(fs.existsSync(path.join(cwd, ".verify", "my_ticket.pdf", "pages.json")));
});

test("a checklist whose ids would share a question name is refused before any request: kind, an id ending in _at, an id used twice", async () => {
  for (const ids of [["kind"], ["seal", "seal_at"], ["seal", "seal"], ["has space"]]) {
    write("clash.json", JSON.stringify({ pages: { certification: "A page with a navy band across its top." }, marks: ids.map((id) => ({ id, page: "certification", mark: id, present: "", question: "Is there a red seal in `images[0].image`?", box: "the red seal in `images[0].image`" })) }));
    const { values: [error], jev } = await steps([withTask(pagesStep, 'const task = { document: "certificate.pdf", checklist: "clash.json" };')], { fails: true });
    assert.match(error.message, /a mark's id is letters, digits and _, used once, not kind and not ending in _at/, ids.join(", "));
    assert.equal(jev.requests.length, 0, `${ids.join(", ")}: no request`);
  }
});
