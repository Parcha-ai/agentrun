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
import { registerFauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, citation, detectOnce, firstLine, formatFragment, guardResult, imageHeader, judge, limitsFromModel, linkSafe, notBuilt, packRequests, parseCitation, parseFragment, plan, readMedia, reportMiss, resolveLimits, see, visionContext, visionSection, withReadMedia } from "@parcha/pi-vision";
import { callContext, createVisionExtension, modelsEyes, modelsOf, packageProviders, piResult } from "@parcha/pi-vision/durable";
import { piAiEyes } from "@parcha/pi-vision/eyes/pi-ai";
import { childEnvOf, inheritedEnv, nodeVisionEnv } from "@parcha/pi-vision/node";
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
  docxBytes, fakeEyes, fixtureDir, letterPdf, limitViolations, pngBytes, signedLink, xlsxBytes,
} from "@parcha/pi-vision/testing";
import { ftyp } from "./support/images.mjs";
import { withPrograms } from "./support/programs.mjs";

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
// quoted, bracketed, after `url=`, closed by punctuation, in a markdown link or in a JSON body whose slashes are escaped;
// a link that carries the provider's key in its query or in its authority, a secret in its fragment, a scheme in capitals,
// plain http, or a web socket.
const WRAPS = [
  (l) => l, (l) => `"${l}"`, (l) => `'${l}'`, (l) => `\`${l}\``, (l) => `(${l})`, (l) => `[${l}]`, (l) => `<${l}>`, (l) => `{${l}}`,
  (l) => `url=${l}`, (l) => `${l},`, (l) => `(see ${l}).`, (l) => `[the file](${l})`, (l) => `{"url":"${l}","status":401}`,
  (l) => `{"url":"${l.split("/").join("\\/")}","status":401}`,
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
  `wss://connect.sentinel.invalid/?apiKey=${KEY}&signingKey=${SENTINEL_LINK_TOKEN}`,
  `ws://live.sentinel.invalid/session?X-Sentinel-Signature=${SENTINEL_LINK_SIGNATURE}`,
];
// A key where no link carries it: the eyes adapter holds the exact string and takes it out of an error's words.
const BARE_KEY_LINES = [`Incorrect API key provided: ${KEY}`, `401 Authorization: Bearer ${KEY}`, `rejected ${KEY} (${KEY})`, `{"error":{"message":"bad key ${KEY}"}}`];
const lineWith = (wrap, link) => `request to ${WRAPS[wrap](LINKS[link])} failed with status 401`;
const FIRST_LINES = WRAPS.flatMap((_, wrap) => LINKS.map((__, link) => lineWith(wrap, link)));
/** The error as an SDK throws it: that first line, then lines that carry the key and the link again. */
const failure = (line) => sdkError(`${line}\nsecond line ${KEY} ${LINK}`);

/** What the adapter hands the guard for one call: the route's limits, who looks, and sinks whose every record is scanned. */
const guardSetup = (sink, limits, eyes, images, providers = []) => ({
  limits, eyes, scope: { label: "sweep", deriveDir: sink.deriveDir }, providers, sources: {}, ...(images ? { images } : {}),
  evidence: { file: async (label, record) => { sink.out("receipt", { label, record }); return { path: `evidence/${label}.md` }; } },
  onLook: (event) => sink.out("look event", event),
  onMiss: (event) => sink.out("miss event", event),
});
/** A screenshot result the guard sends to the eyes, and the guard's answer for each of `eyes`: a text-only lead, so the
 *  eyes look, and each failing look is the miss the model reads, the receipt and the host's event. */
const shot = (width = 40) => ({ content: [{ type: "text", text: "a screenshot" }, png(width, 30)], details: { path: "shot.png", media: { kind: "image", path: "shot.png", ask: "what is it?" } } });
async function missesThrough(sink, eyes, call = { ...CALL, model: TEXT_MODEL }, count = FIRST_LINES.length) {
  assert.ok(eyes, "the route has eyes: without them every look is a clean miss and no poisoned answer is tested");
  const limits = resolveLimits(call.model);
  let asked = 0;
  const watched = { ...eyes, see: (request, signal) => { asked += 1; return eyes.see(request, signal); } };
  for (let i = 0; i < count; i++) sink.result("miss", await guardResult(shot(40 + i), call, guardSetup(sink, limits, watched)), limits);
  assert.equal(asked, count, "every poisoned answer was asked for");
}
/** The eyes' errors, one per line, each with the key and the link again on a second line. */
const failing = (lines) => lines.map((line) => ({ fail: `${line}\nsecond line ${KEY} ${LINK}` }));
/** pi-ai's catalog on its faux provider: a model that sees, one that does not, answering `responses` in order. */
const catalog = (responses) => {
  const faux = fauxProvider({ models: [{ id: "sees", input: ["text", "image"], reasoning: true }, { id: "lead-1", input: ["text"] }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
};
const errorAnswers = (lines) => lines.map((line) => fauxAssistantMessage("", { stopReason: "error", errorMessage: `${line}\nsecond line ${KEY} ${LINK}` }));

// A process that holds a key and a link in its environment. What a program a read starts is given of it is the question.
const PLANTED = { VISION_SWEEP_KEY: KEY, VISION_SWEEP_LINK: LINK };
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** The programs started by what a case does, by pi's own environment and by the adapter's, and what each was started with.
 *  `how.env` names, as a function run once the process holds the sentinels, the environment a host passes. */
async function programsGiven(sink, how) {
  const ran = await withPrograms(sink.workDir, PLANTED, async () => {
    const context = visionContext();
    if (how.piDirect) return void (await new NodeExecutionEnv({ cwd: sink.workDir }).exec(["pdftotext", "-v"], undefined, context));
    const options = { evidence: { file: async () => null }, scope: () => ({ label: "sweep", deriveDir: sink.deriveDir }), ...(how.env ? { env: how.env() } : {}) };
    const extension = createVisionExtension(options);
    const pi = new NodeExecutionEnv({ cwd: sink.workDir });
    await extension.pdfText(letterPdf());
    await writeFile(`${sink.workDir}/clip.mp4`, ftyp("isom", "mp41"));
    await extension.read(pi, { path: "clip.mp4" }, CALL);
    await writeFile(`${sink.workDir}/proof.docx`, docxBytes());
    await extension.read(pi, { path: "proof.docx", ask: "what does it say?" }, CALL);
  });
  if (!Object.keys(ran).length) throw new Error("no program was started, so there is nothing to scan");
  for (const [program, dump] of Object.entries(ran)) if (!/^PATH=/m.test(dump)) throw new Error(`${program} did not run with an environment`);
  sink.out("programs started", ran);
  return ran;
}
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
  { id: ".#packRequests", run: ({ out }) => out("requests", packRequests([png(10, 10), png(20, 20), png(30, 30)], (b) => b.data.length, () => 2, DEFAULT_LIMITS.requestBytes)) },
  {
    // Each request to eyes whose errors carry the key and links: the miss `vision.see` throws, its receipt and its event.
    id: ".#see",
    run: async (sink) => {
      const eyes = fakeEyes({ answers: failing(FIRST_LINES) });
      for (let i = 0; i < FIRST_LINES.length; i++) sink.out("thrown", await see({ ask: "what is it?", images: [png(40, 30 + i)] }, undefined, CALL, guardSetup(sink, LIMITS, eyes)).catch((error) => error));
    },
  },
  {
    // Each request to a Jev whose errors carry the key and links: the miss `vision.judge` throws, its receipt and event.
    id: ".#judge",
    run: async (sink) => {
      let n = 0;
      const jev = { judge: async () => { throw failure(FIRST_LINES[n++]); } };
      for (let i = 0; i < FIRST_LINES.length; i++) sink.out("thrown", await judge({ images: [png(300, 300 + i)], questions: { q: { type: "noul", instructions: "Is it a chart?" } } }, undefined, CALL, { ...guardSetup(sink, LIMITS), jev }).catch((error) => error));
    },
  },
  { id: ".#SeeMiss", exempt: "an error class" },
  { id: ".#NotBuiltError", exempt: "an error class" },
  { id: ".#notBuilt", exempt: "names a part chosen in source" },
  { id: "./durable#createVisionExtension", run: async (sink) => sink.out("extension", (await handle(sink)).extension) },
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
  {
    id: "./durable#VisionHandle.see",
    run: async (sink) => {
      const path = `${sink.workDir}/shot.png?${SENTINEL_LINK_QUERY}`;
      sink.echoes.push(path, basename(path));
      await writeFile(path, pngBytes(3000, 1000));
      const global = (await handle(sink)).see(nodeVisionEnv({ cwd: sink.workDir }), CALL);
      sink.out("thrown", await global.execute({ ask: "what is the total?", paths: [path] }).catch((error) => error));
      sink.out("answer", await global.execute({ ask: "what is the total?", paths: [path] }));
    },
  },
  {
    id: "./durable#VisionHandle.judge",
    run: async (sink) => {
      const path = `${sink.workDir}/frame.png?${SENTINEL_LINK_QUERY}`;
      sink.echoes.push(path, basename(path));
      await writeFile(path, pngBytes(3000, 1000));
      let calls = 0;
      const judge = async () => { if (calls++ === 0) throw failure(lineWith(1, 1)); return { model: "jev-1.14.0", answers: { where: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 0.5 }, confidence: 0.5 } }, usage: { input_tokens: 10, output_tokens: 0 }, cost_usd: null }; };
      const global = createVisionExtension({ jev: { judge }, evidence: { file: async (label, record) => { sink.out("receipt", { label, record }); return { path: `evidence/${label}.md` }; } }, scope: () => ({ label: "sweep", deriveDir: sink.deriveDir }), onLook: (event) => sink.out("look event", event), onMiss: (event) => sink.out("miss event", event) }).judge(nodeVisionEnv({ cwd: sink.workDir }), CALL);
      const ask = { paths: [path], questions: { where: { type: "box", instructions: "the total" } } };
      sink.out("thrown", await global.execute(ask).catch((error) => error));
      sink.out("answer", await global.execute(ask));
    },
  },
  { id: "./node#nodeVisionEnv", run: ({ out, workDir }) => { const node = nodeVisionEnv({ cwd: workDir }); out("env", { id: node.id, cwd: node.cwd }); } },
  {
    id: "./eyes/pi-ai#piAiEyes",
    run: async (sink) => {
      sink.out("eyes", piAiEyes(MODEL, { apiKey: () => KEY, onPayload: (payload) => payload }));
      // pi-ai's own request path on its faux provider: a failed request carries the first line, a bare key and the link
      // again, and a request that throws carries both in its message.
      const faux = registerFauxProvider({ models: [{ id: "faux-eyes", reasoning: true, input: ["text", "image"], cost: MODEL.cost }] });
      try {
        const lines = [...FIRST_LINES, ...BARE_KEY_LINES];
        faux.setResponses([...errorAnswers(lines), () => { throw new Error(`could not sign the request with ${KEY} for ${LINK}`); }]);
        await missesThrough(sink, piAiEyes(faux.getModel(), { apiKey: () => KEY }), undefined, lines.length + 1);
      } finally { faux.unregister(); }
    },
  },
  provider("./providers/unpdf#unpdfProvider", () => unpdfProvider()),
  provider("./providers/pdfium#pdfiumProvider", () => pdfiumProvider()),
  provider("./providers/office-js#officeJsProvider", () => officeJsProvider()),
  provider("./providers/photon#photonImages", () => photonImages()),
  provider("./providers/sharp#sharpImages", () => sharpImages(Object.assign(() => ({}), { token: KEY }))),
  provider("./providers/poppler#popplerProvider", () => popplerProvider()),
  provider("./providers/ffmpeg#ffmpegProvider", () => ffmpegProvider()),
  provider("./providers/soffice#sofficeProvider", () => sofficeProvider()),
  {
    id: ".#readMedia",
    run: async (sink) => {
      const reader = nodeVisionEnv({ cwd: sink.workDir });
      const setup = guardSetup(sink, LIMITS, undefined, undefined, packageProviders());
      // A file saved under the name of the link it came from: the text read from it is kept under a name without the
      // link's query and fragment, and the result's `details.document.text` names that file. A PDF is told by its bytes;
      // an office file by its extension, which such a name hides, so what it comes back as is scanned and not required.
      for (const [name, bytes, pages, required] of [["statement.pdf", letterPdf(), [undefined, 1], true], ["report.docx", docxBytes(), [undefined], false], ["ledger.xlsx", xlsxBytes(), [undefined], false]]) {
        const path = `${name}?${SENTINEL_LINK_QUERY}#section-2`;
        sink.echoes.push(path);
        await writeFile(`${sink.workDir}/${path}`, bytes);
        for (const page of pages) {
          const out = await readMedia(reader, { path, ...(page ? { page } : {}) }, CALL, setup);
          assert.ok(out, `${name} is read`);
          sink.result("saved text", out, LIMITS);
          const kept = out.details?.document?.text;
          if (!kept && !required) continue;
          assert.ok(kept, `${name} keeps its text`);
          assert.equal(basename(kept).replace(/-[0-9a-f]{16}/, "-<hash>"), `${name}-<hash>${page ? `-p${page}` : ""}.txt`, "the kept text is named for the file, not the link");
          assert.ok(readFileSync(`${sink.workDir}/${kept}`.replace(`${sink.workDir}//`, "/"), "utf8").trim(), "and it holds the text");
        }
      }
      // The lead takes no images: `read` shows the image and the guard, as the adapter runs it after `read`, has the eyes
      // look at it for the question asked; they fail, each time with another first line.
      await writeFile(`${sink.workDir}/shot.png`, pngBytes(40, 30));
      const blind = { ...CALL, model: TEXT_MODEL };
      const limits = resolveLimits(TEXT_MODEL);
      const shown = { ...limits, image: { ...limits.image, native: true } };
      const eyes = fakeEyes({ answers: failing(FIRST_LINES) });
      for (let i = 0; i < FIRST_LINES.length; i++) {
        const read = await readMedia(reader, { path: "shot.png", ask: "what is it?" }, blind, guardSetup(sink, limits, eyes, sharpImages(sharp)));
        sink.result("read", read, shown);
        sink.result("miss", await guardResult(read, blind, guardSetup(sink, limits, eyes)), limits);
      }
      assert.equal(eyes.ledger.length, FIRST_LINES.length, "every poisoned answer was asked for");
    },
  },
  {
    id: "./durable#callContext",
    run: async (sink) => {
      const kept = new Map();
      const catalogued = catalog([fauxAssistantMessage("a described screenshot"), ...errorAnswers(FIRST_LINES.slice(0, 14))]);
      let asked = 0;
      const models = { getModel: (provider, id) => catalogued.getModel(provider, id), completeSimple: (...request) => { asked += 1; return catalogued.completeSimple(...request); } };
      const api = {
        callId: "call-1", conversationId: "conv-1", models,
        agent: async () => ({ model: { provider: "faux", modelId: "lead-1" } }),
        memo: async (key, ...rest) => (rest.length === 1 ? kept.get(key) : (kept.set(key, rest[0]), rest[0])),
      };
      const call = await callContext(api, { abortSignal: undefined, value: () => undefined });
      sink.out("call", { conversationId: call.conversationId, callId: call.callId, model: call.model?.id, aborted: call.signal?.aborted });
      const extension = createVisionExtension({
        eyesModel: { provider: "faux", modelId: "sees" }, evidence: { file: async (label, record) => { sink.out("receipt", { label, record }); return { path: `evidence/${label}.md` }; } },
        scope: () => ({ label: "sweep", deriveDir: sink.deriveDir }), onLook: (event) => sink.out("look event", event), onMiss: (event) => sink.out("miss event", event),
      });
      const limits = resolveLimits(call.model);
      for (let i = 0; i < 15; i++) sink.result("fitted", await extension.fit(shot(40 + i), call), limits);
      assert.equal(asked, 15, "the eyes were asked every time: one answer and fourteen poisoned errors");
      assert.deepEqual([...kept.keys()].map((key) => key.slice(0, key.lastIndexOf(":"))), ["vision:look", "vision:told"], "the one look that was answered is a memo, then that it was told, and the failures are none");
      sink.out("memos", [...kept]);
    },
  },
  {
    id: "./durable#piResult",
    run: ({ out, result }) => {
      result("converted", piResult({ content: [{ type: "text", text: "a screenshot" }, png(1500, 900)], details: { path: "shot.png", media: { kind: "image" } }, usage: USAGE }), LIMITS);
      out("an error", piResult({ content: [{ type: "text", text: "Cannot read shot.png: to_s must be greater than from_s." }], isError: true }));
    },
  },
  {
    id: "./durable#modelsEyes",
    run: async (sink) => {
      const door = modelsOf({ models: catalog(errorAnswers(FIRST_LINES)) });
      const eyes = modelsEyes(door, { provider: "faux", modelId: "sees" }, { thinking: "off" });
      sink.out("eyes", eyes);
      sink.out("a model the catalog lacks", modelsEyes(door, { provider: "faux", modelId: "nope" }) ?? null);
      sink.out("a model that cannot see", modelsEyes(door, { provider: "faux", modelId: "lead-1" }) ?? null);
      await missesThrough(sink, eyes);
    },
  },
  {
    id: "./durable#modelsOf",
    run: ({ out }) => {
      const door = modelsOf({ models: catalog([]) });
      out("catalog entry", door?.getModel("faux", "sees"));
      out("where pi has none", [modelsOf({}), modelsOf(null), modelsOf({ models: { getModel: () => undefined } })].map((found) => found ?? null));
    },
  },
  {
    id: "./durable#packageProviders",
    run: async ({ out }) => {
      const list = packageProviders();
      out("providers", list);
      out("detections", await Promise.all(list.map((one, i) => detectOnce(one, env(`sweep-package-${i}`)))));
    },
  },
  {
    id: "./durable#createVisionExtension.env",
    run: async (sink) => {
      // By default, and with the environment a host names; a key in this process reaches none of the programs.
      await programsGiven(sink, {});
      await programsGiven(sink, { env: () => ({ ...inheritedEnv() }) });
    },
  },
  {
    id: "./node#nodeVisionEnv.env",
    run: async (sink) => {
      const ran = await withPrograms(sink.workDir, PLANTED, async () => {
        const context = visionContext();
        await nodeVisionEnv({ cwd: sink.workDir }).exec(["pdftotext", "-v"], undefined, context);
        await nodeVisionEnv({ cwd: sink.workDir, env: { PATH: process.env.PATH } }).exec(["pdfinfo"], undefined, context);
        await nodeVisionEnv({ cwd: sink.workDir }).exec(["ffprobe"], { env: { EXTRA: "1" } }, context);
      });
      assert.deepEqual(Object.keys(ran).sort(), ["ffprobe", "pdfinfo", "pdftotext"]);
      sink.out("programs started", ran);
    },
  },
  { id: "./node#inheritedEnv", run: async ({ out, workDir }) => { await withPrograms(workDir, PLANTED, async () => out("inherited", inheritedEnv())); } },
  { id: "./node#childEnvOf", run: async ({ out, workDir }) => { await withPrograms(workDir, PLANTED, async () => { out("by default", childEnvOf(undefined)); out("named", childEnvOf({ PATH: "/bin", GONE: undefined })); }); } },
  { id: "./testing#*", exempt: "test support: nothing a run calls" },
];

/** What is built today; the sweep must run these to the end, never skip them. */
const BUILT = [
  ".#limitsFromModel", ".#resolveLimits", ".#detectOnce", ".#linkSafe", ".#firstLine", ".#guardResult", ".#readMedia", ".#visionContext", ".#parseFragment",
  ".#formatFragment", ".#citation", ".#parseCitation", ".#withReadMedia", ".#visionSection", ".#plan", ".#packRequests", ".#see",
  "./durable#createVisionExtension", "./durable#createVisionExtension.env", "./durable#VisionHandle.fit", "./durable#VisionHandle.pdfText", "./durable#VisionHandle.read", "./durable#VisionHandle.see", "./durable#VisionHandle.judge", ".#judge",
  "./durable#callContext", "./durable#piResult", "./durable#modelsEyes", "./durable#modelsOf", "./durable#packageProviders",
  "./node#nodeVisionEnv", "./node#nodeVisionEnv.env", "./node#inheritedEnv", "./node#childEnvOf", "./eyes/pi-ai#piAiEyes",
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

test("the sweep is red on a leak in a result, an error, a derived name and a derived file, on a link or a key kept in a miss, on a program given the process's environment, on a kept file named for the link, on an oversize image, and lists what it could not run", async () => {
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
      { id: "x#unsafeBareKey", run: (sink) => filedMiss(sink, `the vision route failed: ${BARE_KEY_LINES[0]}`) },
      // A program given pi's own environment, which is the whole of this process's; and one given what a host passed.
      { id: "x#piEnvDirect", run: (sink) => programsGiven(sink, { piDirect: true }) },
      { id: "x#hostPassedKey", run: (sink) => programsGiven(sink, { env: () => ({ ...inheritedEnv(), VISION_SWEEP_KEY: KEY }) }) },
      // A text file kept under the name of the link, past its `?`.
      { id: "x#savedUnderTheLink", run: ({ result }) => result("r", { content: [{ type: "text", text: "saved" }], details: { document: { text: `evidence/media/statement.pdf?${SENTINEL_LINK_QUERY}.txt` } } }, LIMITS) },
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
      "eyesKey derived", "eyesKey x#echoKey:c", "eyesKey x#hostPassedKey:programs started", "eyesKey x#leakDetail:d", "eyesKey x#leakError:thrown", "eyesKey x#leakResult:r",
      "eyesKey x#piEnvDirect:programs started", "eyesKey x#unsafeBareKey:miss event", "eyesKey x#unsafeBareKey:receipt", "eyesKey x#unsafeQuoted:miss event", "eyesKey x#unsafeQuoted:receipt",
      "linkSignature derived", "linkSignature x#echoQuery:c", "linkSignature x#leakDetail:d", "linkSignature x#leakError:thrown", "linkSignature x#piEnvDirect:programs started",
      "linkSignature x#savedUnderTheLink:r", "linkSignature x#unsafeFirstLine:miss event", "linkSignature x#unsafeFirstLine:receipt",
      "linkToken derived", "linkToken x#echoPart:r", "linkToken x#echoQuery:c", "linkToken x#leakDetail:d", "linkToken x#leakError:thrown", "linkToken x#piEnvDirect:programs started",
      "linkToken x#savedUnderTheLink:r", "linkToken x#unsafeFirstLine:miss event", "linkToken x#unsafeFirstLine:receipt",
    ], "a caller's own string may come back verbatim; any part of it elsewhere, and the key anywhere, is a finding");
    assert.deepEqual(violations, ["x#oversize r: content[0]: 3000x10, over 1600x1600"]);
    assert.deepEqual(rows.map((r) => `${r.id} ${r.outcome}`), [
      "x#leakResult swept", "x#leakError threw", "x#leakDetail swept", "x#leakDerived swept", "x#leakDerivedFile swept", "x#oversize swept",
      "x#unsafeFirstLine swept", "x#unsafeQuoted swept", "x#unsafeBareKey swept", "x#piEnvDirect swept", "x#hostPassedKey swept", "x#savedUnderTheLink swept", "x#safeFirstLine swept", "x#stub skipped", "x#broken threw", "x#echo swept", "x#echoKey swept", "x#echoPart swept", "x#echoQuery swept", "x#exempt exempt", "x#clean swept",
    ]);
    assert.equal(rows.find((r) => r.id === "x#stub").detail, "a stub is not built");
    assert.equal(rows.find((r) => r.id === "x#broken").detail, "TypeError: not what this case expected");
  } finally { await dir.remove(); }
});
