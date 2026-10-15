// The live eyes check: a host's composition of the built package (`read`, `fit` and `see` from `./durable`, eyes from
// `./eyes/pi-ai`) against a real model, the path no fake covers. Not part of `npm test`: it needs a key and spends about
// a cent. From the repository root, after `npm ci --ignore-scripts && npm run build`:
//   PI_VISION_LIVE_EYES=<provider>/<model id> [PI_VISION_LIVE_BASE_URL=<gateway>] node packages/pi-vision/test/live/eyes.mjs
// The eyes are pi-ai's catalog entry of that id, keyed by the variable pi-ai reads for the provider; a gateway's base URL
// replaces the entry's own. Four checks on files `./testing` builds: a scanned letter whose identifier the eyes must
// read exactly; page 2 of a two-page PDF, read with `page`; the letter's page, rendered by `read` and saved as a file,
// asked about through `vision.see` by path; and the receipts, priced with tokens for every paid look and at 0 for a miss
// with no eyes. The last stdout line is `ok: pi-vision live eyes passed` or `not ok: <step>: <reason>`.
// Nothing printed carries the key or the gateway's address.

let hidden = [];
const say = (line) => console.log(hidden.reduce((text, secret) => text.split(secret).join("[hidden]"), line));
const done = (line) => { say(line); process.exit(line.startsWith("ok:") ? 0 : 1); };
const firstLine = (value) => String(value?.message ?? value).split("\n")[0].slice(0, 300);

const spec = process.env.PI_VISION_LIVE_EYES?.trim() ?? "";
const slash = spec.indexOf("/");
if (slash < 1 || slash === spec.length - 1) done("not ok: preflight: PI_VISION_LIVE_EYES is not set to <provider>/<model id>, the id pi-ai's catalog uses");
const [provider, modelId] = [spec.slice(0, slash), spec.slice(slash + 1)];

let loaded;
try {
  loaded = await Promise.all([
    import("@earendil-works/pi-ai/compat"), import("@parcha/pi-vision/durable"), import("@parcha/pi-vision/eyes/pi-ai"),
    import("@parcha/pi-vision/node"), import("@parcha/pi-vision/testing"), import("sharp"),
  ]);
} catch (error) {
  done(`not ok: preflight: ${firstLine(error)}; run npm ci --ignore-scripts && npm run build from the repository root`);
}
const [{ findEnvKeys, getEnvApiKey, getModel }, { createVisionExtension }, { piAiEyes }, { nodeVisionEnv }, { fixtureDir, pdfBytes, scanPdf }, { default: sharp }] = loaded;

const catalog = getModel(provider, modelId);
if (!catalog) done(`not ok: preflight: pi-ai's catalog has no model ${spec}`);
if (!catalog.input.includes("image")) done(`not ok: preflight: ${spec} takes no images`);
// The variables pi-ai reads for the provider's key: the ones it finds in an environment that sets every name.
const keyNames = findEnvKeys(provider, new Proxy({}, { get: () => "set" })) ?? [];
const key = getEnvApiKey(provider);
if (!key) done(`not ok: preflight: no key for ${provider} in the environment (pi-ai reads ${keyNames.join(" or ") || "no variable for it"})`);
const gateway = process.env.PI_VISION_LIVE_BASE_URL?.trim();
hidden = [key, ...(gateway ? [gateway, URL.canParse(gateway) ? new URL(gateway).host : gateway] : [])].filter((secret) => secret.length > 0);
const eyes = piAiEyes(gateway ? { ...catalog, baseUrl: gateway } : catalog, { apiKey: () => key });

/** The identifiers the eyes must read: the one `scanPdf` prints, and one per page of the two-page PDF. */
const LETTER_ID = "00-0000000";
const PAGE_IDS = ["3172-0465", "5809-2318"];
const LETTER_ASK = "What is the Employer Identification Number on this letter? Answer with the number only.";
const PAGE_ASK = "What is the reference number on this page? Answer with the number only.";
/** True when `answer` holds `id` as one whole run of digits and dashes. */
const holds = (answer, id) => answer.split(/[^0-9-]+/).includes(id);

const records = [];
const misses = [];
// The lead takes no images, so every image a read makes goes to the eyes.
const LEAD = { id: "text-only-lead", input: ["text"] };
let callId = 0;

/** One read and the fit of its result, as a host whose `read` is its own makes them. `asked`: every look the eyes were
 *  asked for, answered or not; `answered`: those that came back with words. */
async function readAndFit(vision, env, args) {
  const [filed, heard] = [records.length, misses.length];
  const call = { conversationId: "live-eyes", callId: String(++callId), model: LEAD, signal: undefined };
  const media = await vision.read(env, args, call);
  if (!media) throw new Error(`read left ${args.path} to the host's text read`);
  if (media.isError) throw new Error(firstLine(media.content[0]?.text));
  const fitted = await vision.fit(media, call);
  const looks = records.slice(filed);
  const asked = looks.filter((r) => r.args.model === eyes.model);
  return { fitted, looks, asked, answered: asked.filter((r) => r.status === "ok"), misses: misses.slice(heard) };
}

/** What the eyes answered, once the fitted result holds no image for the lead and carries each answer; or why not. */
function answerOf(read) {
  if (read.misses.length) throw new Error(`${read.misses[0].code}: ${read.misses[0].reason}`);
  if (!read.answered.length) throw new Error("no look was filed");
  const text = read.fitted.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  if (read.fitted.content.some((block) => block.type === "image")) throw new Error("the fitted result still holds an image for a lead that takes none");
  if (!read.answered.every((r) => text.some((t) => t.includes(r.body)))) throw new Error("the fitted result does not carry the eyes' answer");
  return read.answered.map((r) => r.body).join("\n");
}

/** Tokens and dollars of looks; a request that failed after it was sent has no known price and is counted as such. */
const spend = (looks) => {
  const [tokensIn, tokensOut, usd] = looks.reduce(([i, o, d], r) => [i + (r.facts.tokens_in ?? 0), o + (r.facts.tokens_out ?? 0), d + (r.facts.cost_usd ?? 0)], [0, 0, 0]);
  const unpriced = looks.filter((r) => typeof r.facts.cost_usd !== "number").length;
  return `${looks.length} look${looks.length === 1 ? "" : "s"}, ${tokensIn} tokens in, ${tokensOut} out, $${usd.toFixed(6)}${unpriced ? ` and ${unpriced} of unknown price` : ""}`;
};

/** Every look the eyes were asked for, and each step's outcome. A check's `run` adds its asked looks to `looks` and
 *  returns what it found, or throws why it failed. */
const asked = [];
const checks = [];
async function check(step, run) {
  const looks = [];
  let outcome;
  try { outcome = { ok: true, note: await run(looks) }; } catch (error) { outcome = { ok: false, reason: firstLine(error) }; }
  asked.push(...looks);
  checks.push({ step, ...outcome });
  say(`${checks.length} ${step}: ${outcome.ok ? `ok, ${outcome.note}` : `not ok, ${outcome.reason}`}${looks.length ? ` (${spend(looks)})` : ""}`);
}

say("pi-vision live eyes");
say(`model: ${spec}${gateway ? ", through the gateway PI_VISION_LIVE_BASE_URL names" : ""}`);
let dir;
try {
  dir = await fixtureDir("pi-vision-live-eyes-");
  await dir.file("letter-scan.pdf", await scanPdf((input, options) => sharp(input, options)));
  const lines = (page) => ["EXAMPLE WIDGETS LLC", `Statement, page ${page} of 2`, "", `Reference number: ${PAGE_IDS[page - 1]}`, "", "This is a synthetic test document."];
  await dir.file("statement.pdf", pdfBytes([{ lines: lines(1) }, { lines: lines(2) }]));
} catch (error) {
  checks.push({ step: "setup", ok: false, reason: firstLine(error) });
}

if (!checks.length) {
  const env = nodeVisionEnv({ cwd: dir.path });
  const host = (withEyes) => createVisionExtension({
    ...(withEyes ? { eyes } : {}),
    evidence: { file: async (_label, record) => { records.push(record); return null; } },
    scope: () => ({ label: "live-eyes", deriveDir: `${dir.path}/derived` }),
    onMiss: (miss) => { misses.push(miss); },
  });

  await check("scanned letter", async (looks) => {
    const read = await readAndFit(host(true), env, { path: "letter-scan.pdf", ask: LETTER_ASK });
    looks.push(...read.asked);
    const answer = answerOf(read);
    if (!holds(answer, LETTER_ID)) throw new Error(`the eyes answered "${firstLine(answer)}", not ${LETTER_ID}`);
    return `read ${LETTER_ID} exactly`;
  });

  await check("page 2", async (looks) => {
    const read = await readAndFit(host(true), env, { path: "statement.pdf", page: 2, ask: PAGE_ASK });
    looks.push(...read.asked);
    const answer = answerOf(read);
    if (holds(answer, PAGE_IDS[0])) throw new Error(`the eyes named page 1's ${PAGE_IDS[0]}: the read showed them another page`);
    if (!holds(answer, PAGE_IDS[1])) throw new Error(`the eyes answered "${firstLine(answer)}", not ${PAGE_IDS[1]}`);
    const pages = read.answered.map((r) => r.args.page);
    if (pages.some((page) => page !== 2)) throw new Error(`a receipt names page ${pages.join(", ")}, not 2`);
    return `named ${PAGE_IDS[1]}, which only page 2 holds`;
  });

  await check("vision.see", async (looks) => {
    const vision = host(true);
    const call = { conversationId: "live-eyes", callId: String(++callId), model: { id: "image-lead", input: ["text", "image"] }, signal: undefined };
    const page = (await vision.read(env, { path: "letter-scan.pdf" }, call))?.content.find((block) => block.type === "image");
    if (!page) throw new Error("read did not render the scan's page as an image");
    const file = `letter-page-1.${page.mimeType.split("/")[1]}`;
    await dir.file(file, Buffer.from(page.data, "base64"));
    const filed = records.length;
    const seen = await vision.see(env, call).execute({ ask: LETTER_ASK, paths: [file], fragments: ["letter-scan.pdf#page=1"] });
    looks.push(...records.slice(filed));
    if (!holds(seen.text, LETTER_ID)) throw new Error(`the eyes answered "${firstLine(seen.text)}", not ${LETTER_ID}`);
    if (seen.model !== eyes.model || !(seen.costUsd > 0) || looks.length !== 1) throw new Error(`vision.see returned ${seen.model} at ${seen.costUsd} with ${looks.length} looks filed`);
    return `read ${LETTER_ID} exactly from the page by path, one look at $${seen.costUsd.toFixed(6)}`;
  });

  await check("receipts", async () => {
    const answered = asked.filter((r) => r.status === "ok");
    if (!answered.length) throw new Error("no paid look was filed");
    for (const { facts } of answered) {
      if (facts.cost_usd === null) throw new Error(`a look cost null: pi-ai's catalog has no price for ${spec}`);
      if (typeof facts.cost_usd !== "number" || !(facts.cost_usd > 0)) throw new Error(`a paid look cost ${facts.cost_usd}, not a price above 0`);
      if (!(facts.tokens_in > 0 && facts.tokens_out > 0)) throw new Error(`a paid look has ${facts.tokens_in} tokens in and ${facts.tokens_out} out`);
    }
    const blind = await readAndFit(host(false), env, { path: "letter-scan.pdf", ask: LETTER_ASK });
    if (blind.misses.length !== 1 || blind.misses[0].code !== "no_vision_route") throw new Error(`the read with no eyes was heard as ${blind.misses.map((m) => m.code).join(", ") || "no miss"}, not one no_vision_route`);
    const [miss, ...more] = blind.looks;
    if (!miss || more.length || miss.status !== "failed" || miss.facts.cost_usd !== 0 || miss.facts.tokens_in !== 0 || miss.facts.tokens_out !== 0) {
      throw new Error(`the miss with no eyes filed ${JSON.stringify(blind.looks.map((r) => [r.status, r.facts.cost_usd, r.facts.tokens_in, r.facts.tokens_out]))}, not one failed look at $0 with 0 tokens`);
    }
    return `${answered.length} paid look${answered.length === 1 ? "" : "s"} priced with tokens; the miss with no eyes filed at $0 with 0 tokens`;
  });
}
try { await dir?.remove(); } catch (error) { checks.push({ step: "cleanup", ok: false, reason: firstLine(error) }); }

const reads = checks.filter((c) => ["scanned letter", "page 2", "vision.see"].includes(c.step));
say(`read rate: ${reads.filter((c) => c.ok).length} of 3 identifiers read exactly`);
say(`spend: ${spend(asked)}`);
const failed = checks.find((c) => !c.ok);
done(failed ? `not ok: ${failed.step}: ${failed.reason}` : "ok: pi-vision live eyes passed");
