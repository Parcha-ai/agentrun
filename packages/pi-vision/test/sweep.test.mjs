// The sweep: every public function the package declares, run with the sentinels in its inputs, and what it returns,
// throws, files or derives scanned for them; every image block a result carries held to the limits of the route it was
// built for. A part not built is skipped with its name listed; a function this sweep has no case for is listed too, so a
// gap is visible and never silent. A case is written against its function's declared signature, so it runs for real
// once the stub is replaced, and a leak or an oversize image then fails the suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DEFAULT_LIMITS, citation, detectOnce, firstLine, formatFragment, guardResult, imageHeader, limitsFromModel, linkSafe, notBuilt, parseCitation, parseFragment, plan, reportMiss, resolveLimits, visionContext, visionSection, withReadMedia } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { piAiEyes } from "@parcha/pi-vision/eyes/pi-ai";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";
import { officeJsProvider } from "@parcha/pi-vision/providers/office-js";
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { photonImages } from "@parcha/pi-vision/providers/photon";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { sofficeProvider } from "@parcha/pi-vision/providers/soffice";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import {
  LeakScan, SENTINELS, SENTINEL_EYES_KEY, SENTINEL_LINK_QUERY, SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, SENTINEL_SIGNED_LINK,
  fakeEyes, fixtureDir, limitViolations, pngBytes, signedLink,
} from "@parcha/pi-vision/testing";

const KEY = SENTINEL_EYES_KEY;
const LINK = SENTINEL_SIGNED_LINK;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const png = (width, height) => ({ type: "image", data: Buffer.from(pngBytes(width, height)).toString("base64"), mimeType: "image/png" });

/** What a case's caller gave may come back verbatim (a path in a citation, a tool's own text): the scan does not see those
 *  exact strings, and sees everything else, so a link's token or query anywhere else is a finding. Derived files are
 *  scanned as they are. */
const withoutEchoes = (value, echoes) => (echoes.length && value !== undefined && !(value instanceof Error)
  ? JSON.parse(echoes.reduce((json, text) => json.replaceAll(JSON.stringify(text).slice(1, -1), "<echoed>"), JSON.stringify(value)))
  : value);

/** Runs each case with a sink that scans what the case gives it. A case ends `swept`; or `skipped` when a part it needs
 *  is not built; or `threw`, the error scanned too and listed. Findings and limit violations are the suite's failures. */
async function sweep(cases, deriveDir, workDir) {
  const scan = new LeakScan();
  const violations = [];
  const rows = [];
  for (const spec of cases) {
    if (spec.exempt) { rows.push({ id: spec.id, outcome: "exempt", detail: spec.exempt }); continue; }
    const echoes = [];
    const sink = {
      deriveDir,
      workDir,
      echoes,
      out: (label, value) => scan.value(`${spec.id}:${label}`, withoutEchoes(value, echoes)),
      result: (label, result, limits) => {
        scan.value(`${spec.id}:${label}`, withoutEchoes(result, echoes));
        violations.push(...limitViolations(result, limits).map((v) => `${spec.id} ${label}: ${v}`));
      },
    };
    try {
      await spec.run(sink);
      rows.push({ id: spec.id, outcome: "swept", scanned: scan.covered(`${spec.id}:`) });
    } catch (error) {
      if (error?.code === "not_built") rows.push({ id: spec.id, outcome: "skipped", detail: `${error.part} is not built` });
      else {
        scan.value(`${spec.id}:thrown`, error);
        rows.push({ id: spec.id, outcome: "threw", detail: `${error?.name}: ${String(error?.message).split("\n")[0]}` });
      }
    }
  }
  scan.dir("derived", deriveDir);
  return { rows, scan, violations };
}

// What an SDK error carries: the request, with its credential and its link, beside a clean message.
const sdkError = (message) => Object.assign(new Error(message), { request: { url: LINK, headers: { authorization: `Bearer ${KEY}` } } });
const MODEL = {
  id: "sweep-model", provider: "sweep", api: "sweep", baseUrl: LINK, apiKey: KEY, headers: { authorization: `Bearer ${KEY}` },
  input: ["text", "image"], cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
  inputLimits: { images: { maxPerMessage: 5, resize: { maxWidth: 1600, maxHeight: 1600, maxBytes: 3_000_000, jpegQuality: 70 } }, maxRequestBytes: 10_000_000 },
};
const TEXT_MODEL = { ...MODEL, id: "sweep-text-model", input: ["text"] };
const LIMITS = resolveLimits(MODEL);
const CALL = { conversationId: "sweep-conversation", callId: "sweep-call", model: MODEL, signal: undefined };

// The first line of an error is the line a result, a receipt and an event keep. SDKs put the request's link on it: bare,
// quoted, bracketed, after `url=`, closed by punctuation, in a markdown link or in a JSON body; a link that carries the
// provider's key in its query or in its authority, a secret in its fragment, a scheme in capitals or plain http.
const WRAPS = [
  (l) => l, (l) => `"${l}"`, (l) => `'${l}'`, (l) => `\`${l}\``, (l) => `(${l})`, (l) => `[${l}]`, (l) => `<${l}>`, (l) => `{${l}}`,
  (l) => `url=${l}`, (l) => `${l},`, (l) => `(see ${l}).`, (l) => `[the file](${l})`, (l) => `{"url":"${l}","status":401}`,
];
// Built with the URL API, not written out: the repository's source scan refuses a credential URL in a file.
const withCredentials = Object.assign(new URL("https://files.sentinel.invalid/reports/statement.pdf"), { username: "user", password: KEY }).href;
const LINKS = [
  LINK,
  `https://api.sentinel.invalid/v1/models/m:generate?key=${KEY}`,
  withCredentials,
  `https://files.sentinel.invalid/reports/statement.pdf#token=${SENTINEL_LINK_TOKEN}`,
  LINK.replace("https", "HTTPS"),
  LINK.replace("https", "http"),
];
const lineWith = (wrap, link) => `request to ${WRAPS[wrap](LINKS[link])} failed with status 401`;
const FIRST_LINES = WRAPS.flatMap((_, wrap) => LINKS.map((__, link) => lineWith(wrap, link)));
/** The error as an SDK throws it: that first line, then lines that carry the key and the link again. */
const failure = (line) => sdkError(`${line}\nsecond line ${KEY} ${LINK}`);

/** What the adapter hands the guard for one call: the route's limits, who looks, and sinks whose every record is scanned. */
const guardSetup = (sink, limits, eyes, images) => ({
  limits, eyes, scope: { label: "sweep", deriveDir: sink.deriveDir }, providers: [], sources: {}, ...(images ? { images } : {}),
  evidence: { file: async (label, record) => { sink.out("receipt", { label, record }); return { path: `evidence/${label}.md` }; } },
  onLook: (event) => sink.out("look event", event),
  onMiss: (event) => sink.out("miss event", event),
});
const env = (id) => ({ id, cwd: "/work", exec: async () => ({ ok: false, error: sdkError("program not found") }) });

/** The extension a host builds: eyes that hold the key and fail first, a sink that files every receipt for the scan. */
const handle = (sink) => createVisionExtension({
  eyes: fakeEyes({ answers: [{ fail: "upstream 500" }, "a fake answer"] }),
  evidence: { file: async (label, record) => { sink.out("receipt", { label, record }); return { path: `evidence/${label}.md` }; } },
  scope: () => ({ label: "sweep", deriveDir: sink.deriveDir }),
  onLook: (event) => sink.out("look event", event),
  onMiss: (event) => sink.out("miss event", event),
});

const provider = (id, make) => ({
  id,
  run: async ({ out }) => {
    const built = make();
    out("provider", built);
    out("detection", await detectOnce(built, env(`sweep-${id}`)));
  },
});

const CASES = [
  { id: ".#limitsFromModel", run: ({ out }) => out("limits", limitsFromModel(MODEL)) },
  { id: ".#resolveLimits", run: ({ out }) => out("limits", resolveLimits(MODEL, { requestBytes: 8_000_000, image: { maxBytes: 1_000_000 }, video: { native: true } })) },
  {
    id: ".#detectOnce",
    run: async ({ out }) => {
      const probe = (detect) => ({ name: "sweep", capabilities: [], kinds: [], detect });
      out("detections", await Promise.all([
        ...FIRST_LINES.map((line) => detectOnce(probe(async () => { throw failure(line); }), env("sweep-detect"))),
        detectOnce(probe(async () => { throw sdkError(`probe failed\nsecond line ${KEY} ${LINK}`); }), env("sweep-detect")),
        detectOnce(probe(() => Promise.reject(FIRST_LINES[0])), env("sweep-detect")),
      ]));
    },
  },
  { id: ".#linkSafe", run: ({ out }) => out("lines", FIRST_LINES.map(linkSafe)) },
  { id: ".#firstLine", run: ({ out }) => out("lines", [...FIRST_LINES.map((line) => firstLine(failure(line))), firstLine(FIRST_LINES[0])]) },
  {
    id: ".#guardResult",
    run: async (sink) => {
      const media = (path) => ({ media: { kind: "image", path, ask: "what is it?" } });
      // The lead takes no images, so the eyes look and fail, each time with another first line: the miss the model reads,
      // the receipt and the host's event keep the cause's first line, links cut.
      for (const line of FIRST_LINES) {
        const eyes = fakeEyes({ answers: [{ fail: line }] });
        sink.result("miss", await guardResult({ content: [{ type: "text", text: "a screenshot" }, png(40, 30)], details: media("shot.png") }, { ...CALL, model: TEXT_MODEL }, guardSetup(sink, resolveLimits(TEXT_MODEL), eyes), imageHeader), resolveLimits(TEXT_MODEL));
      }
      // The lead takes images: a wide one is fitted to the route's limits, and the text and the saved path come back as given.
      const path = `downloads/report.pdf?${SENTINEL_LINK_QUERY}`;
      sink.echoes.push(`downloaded ${LINK}`, path);
      sink.result("fitted", await guardResult({ content: [{ type: "text", text: `downloaded ${LINK}` }, png(3000, 1000)], details: media(path) }, CALL, guardSetup(sink, LIMITS, undefined, sharpImages(sharp)), imageHeader), LIMITS);
    },
  },
  { id: ".#visionContext", run: ({ out }) => { const context = visionContext(AbortSignal.abort(sdkError("cut"))); out("context", { text: String(context), value: context.value({ token: Symbol("k") }), aborted: context.abortSignal?.aborted }); } },
  { id: ".#parseFragment", run: ({ out }) => { out("a key the grammar does not have", parseFragment(`page=1&token=${SENTINEL_LINK_TOKEN}`)); out("a fragment", parseFragment("page=2-4&t=1,2")); } },
  { id: ".#formatFragment", run: ({ out }) => out("fragment", formatFragment({ page: { from: 1, to: 2 }, token: SENTINEL_LINK_TOKEN })) },
  { id: ".#citation", run: ({ out, echoes }) => { echoes.push(signedLink("a.pdf")); out("citation", citation(signedLink("a.pdf"), { page: { from: 1, to: 1 } })); } },
  { id: ".#parseCitation", run: ({ out, echoes }) => { echoes.push(signedLink("a.pdf")); out("citation", parseCitation(`${signedLink("a.pdf")}#page=1`)); } },
  { id: ".#withReadMedia", run: ({ out }) => out("tool", withReadMedia({ name: "read", label: "Read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } })) },
  { id: ".#visionSection", run: ({ out }) => out("section", visionSection("Recordings are read by handle.")) },
  { id: ".#plan", run: ({ out }) => out("plan", plan({ kind: "image", bytes: 2_000_000, sha256: "ab".repeat(32), mimeType: "image/png", width: 4000, height: 3000 }, {}, DEFAULT_LIMITS, "show")) },
  { id: ".#NotBuiltError", exempt: "an error class" },
  { id: ".#notBuilt", exempt: "names a part chosen in source" },
  { id: "./durable#createVisionExtension", run: async (sink) => sink.out("tools", (await handle(sink)).tools) },
  {
    id: "./durable#VisionHandle.fit",
    run: async (sink) => {
      sink.echoes.push(`downloaded ${LINK}`);
      sink.result("fitted", await (await handle(sink)).fit({ content: [{ type: "text", text: `downloaded ${LINK}` }, png(3000, 1000)] }, CALL), LIMITS);
    },
  },
  { id: "./durable#VisionHandle.pdfText", run: async (sink) => sink.out("text", await (await handle(sink)).pdfText(Buffer.from(`%PDF-1.4\n% ${KEY}\n%%EOF\n`))) },
  {
    id: "./durable#VisionHandle.read",
    run: async (sink) => {
      const path = `${sink.workDir}/page.png?${SENTINEL_LINK_QUERY}`;
      sink.echoes.push(path, basename(path));
      await writeFile(path, pngBytes(3000, 1000));
      sink.result("read", await (await handle(sink)).read(nodeVisionEnv({ cwd: sink.workDir }), { path, ask: "what is the total?" }, CALL), LIMITS);
    },
  },
  { id: "./node#nodeVisionEnv", run: ({ out, workDir }) => { const node = nodeVisionEnv({ cwd: workDir }); out("env", { id: node.id, cwd: node.cwd }); } },
  { id: "./eyes/pi-ai#piAiEyes", run: ({ out }) => out("eyes", piAiEyes(MODEL, { apiKey: () => KEY, onPayload: (payload) => payload })) },
  provider("./providers/unpdf#unpdfProvider", () => unpdfProvider()),
  provider("./providers/pdfium#pdfiumProvider", () => pdfiumProvider()),
  provider("./providers/office-js#officeJsProvider", () => officeJsProvider()),
  provider("./providers/photon#photonImages", () => photonImages()),
  provider("./providers/sharp#sharpImages", () => sharpImages(Object.assign(() => ({}), { token: KEY }))),
  provider("./providers/poppler#popplerProvider", () => popplerProvider()),
  provider("./providers/ffmpeg#ffmpegProvider", () => ffmpegProvider()),
  provider("./providers/soffice#sofficeProvider", () => sofficeProvider()),
  { id: "./testing#*", exempt: "test support: nothing a run calls" },
];

/** What is built today; the sweep must run these to the end, never skip them. */
const BUILT = [
  ".#limitsFromModel", ".#resolveLimits", ".#detectOnce", ".#linkSafe", ".#firstLine", ".#guardResult", ".#visionContext", ".#parseFragment", ".#formatFragment",
  ".#citation", ".#parseCitation", ".#withReadMedia", ".#visionSection", ".#plan", "./eyes/pi-ai#piAiEyes",
  "./providers/unpdf#unpdfProvider", "./providers/pdfium#pdfiumProvider", "./providers/office-js#officeJsProvider", "./providers/photon#photonImages",
  "./providers/sharp#sharpImages", "./providers/poppler#popplerProvider", "./providers/ffmpeg#ffmpegProvider", "./providers/soffice#sofficeProvider",
];

const declared = async () => {
  const names = [];
  for (const entry of Object.keys(pkg.exports)) {
    const module = await import(entry === "." ? pkg.name : `${pkg.name}${entry.slice(1)}`);
    for (const [name, value] of Object.entries(module)) if (typeof value === "function") names.push(`${entry}#${name}`);
  }
  return names;
};

test("every public function is swept, skipped as not built, or exempt, and nothing it returns, throws or derives holds a sentinel", async (t) => {
  const derived = await fixtureDir("pi-vision-sweep-derived-");
  const work = await fixtureDir("pi-vision-sweep-work-");
  try {
    const { rows, scan, violations } = await sweep(CASES, derived.path, work.path);
    const known = new Set(CASES.map((c) => c.id));
    const gaps = (await declared()).filter((id) => !known.has(id) && !known.has(`${id.split("#")[0]}#*`));
    t.diagnostic(`${rows.filter((r) => r.outcome === "swept").length} swept, ${rows.filter((r) => r.outcome === "skipped").length} not built, ${rows.filter((r) => r.outcome === "threw").length} threw, ${rows.filter((r) => r.outcome === "exempt").length} exempt, ${gaps.length} with no case yet`);
    for (const row of rows.filter((r) => r.outcome !== "swept")) t.diagnostic(`${row.outcome === "skipped" ? "not built" : row.outcome}: ${row.id}${row.detail ? ` (${row.detail})` : ""}`);
    for (const id of gaps) t.diagnostic(`no case yet: ${id}`);
    assert.equal(scan.report(), "no sentinel found");
    assert.deepEqual(violations, []);
    assert.deepEqual(rows.filter((r) => BUILT.includes(r.id) && r.outcome !== "swept"), [], "a built function runs to the end");
    assert.ok(rows.filter((r) => r.outcome === "swept").length >= BUILT.length);
    for (const row of rows.filter((r) => r.outcome === "swept")) assert.ok(row.scanned.records > 0, `${row.id}: a case that hands the scan nothing proves nothing`);
    for (const row of rows.filter((r) => r.outcome === "skipped")) assert.match(row.detail, /^\w+ is not built$/);
  } finally { await derived.remove(); await work.remove(); }
});

test("the sweep is red on a leak in a result, an error, a derived name and a derived file, on a link kept past its origin and path in a miss, on an oversize image, and lists what it could not run", async () => {
  const dir = await fixtureDir("pi-vision-sweep-derived-");
  try {
    const filedMiss = async (sink, reason) => {
      const filing = { conversationId: "c1", label: "n", evidence: { file: async (label, record) => { sink.out("receipt", record); return { path: "evidence/n/1.md" }; } }, onMiss: (event) => sink.out("miss event", event) };
      const record = { tool: "look", args: { path: "a.png", model: "m", native: false }, status: "ok", facts: { sha256: "ab".repeat(32), kind: "image", fragment: "", shown: "", fit: { reduction: "as_is" }, key: "cd".repeat(32) }, body: "" };
      await reportMiss(filing, "read", record, { code: "look_failed", reason });
    };
    const cases = [
      { id: "x#leakResult", run: ({ result }) => result("r", { content: [{ type: "text", text: `via ${KEY}` }] }, LIMITS) },
      { id: "x#leakError", run: () => { throw sdkError(`fetch ${LINK} failed`); } },
      { id: "x#leakDetail", run: ({ out }) => out("d", { details: { cause: sdkError("failed") } }) },
      { id: "x#leakDerived", run: ({ deriveDir }) => writeFile(`${deriveDir}/page-${SENTINEL_LINK_SIGNATURE}.png`, pngBytes(2, 2)) },
      { id: "x#leakDerivedFile", run: ({ deriveDir }) => writeFile(`${deriveDir}/memo.json`, JSON.stringify({ via: KEY })) },
      { id: "x#oversize", run: ({ result }) => result("r", { content: [png(3000, 10)] }, LIMITS) },
      // A miss whose reason keeps an error's first line as it came, and the same miss through `firstLine`.
      { id: "x#unsafeFirstLine", run: (sink) => filedMiss(sink, `the vision route failed: ${String(failure(lineWith(0, 0)).message).split("\n")[0]}`) },
      { id: "x#unsafeQuoted", run: (sink) => filedMiss(sink, `the vision route failed: ${String(failure(lineWith(1, 1)).message).split("\n")[0]}`) },
      { id: "x#safeFirstLine", run: (sink) => filedMiss(sink, `the vision route failed: ${firstLine(failure(lineWith(1, 1)))}`) },
      { id: "x#stub", run: () => notBuilt("a stub") },
      { id: "x#broken", run: () => { throw new TypeError("not what this case expected"); } },
      { id: "x#echo", run: ({ out, echoes }) => { echoes.push(LINK); out("c", { text: `see ${LINK}` }); } },
      { id: "x#echoKey", run: ({ out, echoes }) => { echoes.push(LINK); out("c", { text: `see ${LINK}`, via: KEY }); } },
      { id: "x#echoPart", run: ({ result, echoes }) => { echoes.push(LINK); result("r", { content: [{ type: "text", text: `see ${LINK}` }], details: { via: SENTINEL_LINK_TOKEN } }, LIMITS); } },
      { id: "x#echoQuery", run: ({ out, echoes }) => { echoes.push(LINK); out("c", `see ${SENTINEL_LINK_QUERY}`); } },
      { id: "x#exempt", exempt: "why" },
      { id: "x#clean", run: ({ result }) => result("r", { content: [{ type: "text", text: "fine" }, png(1500, 900)] }, LIMITS) },
    ];
    const { rows, scan, violations } = await sweep(cases, dir.path, dir.path);
    assert.deepEqual([...new Set(scan.findings.map((f) => `${f.sentinel} ${f.source}`))].sort(), [
      "eyesKey derived", "eyesKey x#echoKey:c", "eyesKey x#leakDetail:d", "eyesKey x#leakError:thrown", "eyesKey x#leakResult:r",
      "eyesKey x#unsafeQuoted:miss event", "eyesKey x#unsafeQuoted:receipt",
      "linkSignature derived", "linkSignature x#echoQuery:c", "linkSignature x#leakDetail:d", "linkSignature x#leakError:thrown",
      "linkSignature x#unsafeFirstLine:miss event", "linkSignature x#unsafeFirstLine:receipt",
      "linkToken x#echoPart:r", "linkToken x#echoQuery:c", "linkToken x#leakDetail:d", "linkToken x#leakError:thrown",
      "linkToken x#unsafeFirstLine:miss event", "linkToken x#unsafeFirstLine:receipt",
    ], "a caller's own string may come back verbatim; any part of it elsewhere, and the key anywhere, is a finding");
    assert.deepEqual(violations, ["x#oversize r: content[0]: 3000x10, over 1600x1600"]);
    assert.deepEqual(rows.map((r) => `${r.id} ${r.outcome}`), [
      "x#leakResult swept", "x#leakError threw", "x#leakDetail swept", "x#leakDerived swept", "x#leakDerivedFile swept", "x#oversize swept",
      "x#unsafeFirstLine swept", "x#unsafeQuoted swept", "x#safeFirstLine swept", "x#stub skipped", "x#broken threw", "x#echo swept", "x#echoKey swept", "x#echoPart swept", "x#echoQuery swept", "x#exempt exempt", "x#clean swept",
    ]);
    assert.equal(rows.find((r) => r.id === "x#stub").detail, "a stub is not built");
    assert.equal(rows.find((r) => r.id === "x#broken").detail, "TypeError: not what this case expected");
  } finally { await dir.remove(); }
});
