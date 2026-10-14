// The live eyes check: a host's composition of the built package (`read` and `fit` from `./durable`, eyes from
// `./eyes/pi-ai`) against a real model, the path no fake covers. Not part of `npm test`: it needs a key and spends about
// a cent. From the repository root, after `npm ci --ignore-scripts && npm run build`:
//   PI_VISION_LIVE_EYES=<provider>/<model id> [PI_VISION_LIVE_BASE_URL=<gateway>] node packages/pi-vision/test/live/eyes.mjs
// The eyes are pi-ai's catalog entry of that id, keyed by the variable pi-ai reads for the provider; a gateway's base URL
// replaces the entry's own. Three checks on files `./testing` builds: a scanned letter whose identifier the eyes must
// read exactly; page 2 of a two-page PDF, read with `page`; and the receipts, priced with tokens for every paid look and
// at 0 for a miss with no eyes. The last stdout line is `ok: pi-vision live eyes passed` or `not ok: <step>: <reason>`.
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

const dir = await fixtureDir("pi-vision-live-eyes-");
const records = [];
const misses = [];
const host = (withEyes) => createVisionExtension({
  ...(withEyes ? { eyes } : {}),
  evidence: { file: async (_label, record) => { records.push(record); return null; } },
  scope: () => ({ label: "live-eyes", deriveDir: `${dir.path}/derived` }),
  onMiss: (miss) => { misses.push(miss); },
});
const env = nodeVisionEnv({ cwd: dir.path });
// The lead takes no images, so every image a read makes goes to the eyes.
const LEAD = { id: "text-only-lead", input: ["text"] };
let callId = 0;

/** One read and the fit of its result, as a host whose `read` is its own makes them: the looks filed and the misses heard. */
async function readAndFit(vision, args) {
  const [filed, heard] = [records.length, misses.length];
  const call = { conversationId: "live-eyes", callId: String(++callId), model: LEAD, signal: undefined };
  const media = await vision.read(env, args, call);
  if (!media) throw new Error(`read left ${args.path} to the host's text read`);
  if (media.isError) throw new Error(firstLine(media.content[0]?.text));
  await vision.fit(media, call);
  const looks = records.slice(filed);
  return { looks, paid: looks.filter((r) => r.status === "ok" && !r.args.native), misses: misses.slice(heard) };
}

/** The answer of a read the eyes looked at, or why there is none. */
function answerOf(read) {
  if (read.misses.length) throw new Error(`${read.misses[0].code}: ${read.misses[0].reason}`);
  if (!read.paid.length) throw new Error("no look was filed");
  return read.paid.map((r) => r.body).join("\n");
}

const spend = (looks) => {
  const [tokensIn, tokensOut, usd] = looks.reduce(([i, o, d], r) => [i + (r.facts.tokens_in ?? 0), o + (r.facts.tokens_out ?? 0), d + (r.facts.cost_usd ?? 0)], [0, 0, 0]);
  return `${looks.length} look${looks.length === 1 ? "" : "s"}, ${tokensIn} tokens in, ${tokensOut} out, $${usd.toFixed(6)}`;
};

/** Every paid look of the run, and each check's step and outcome. A check's `run` adds the looks it paid for to `looks`
 *  and returns what it found, or throws why it failed. */
const paid = [];
const checks = [];
async function check(step, run) {
  const looks = [];
  let outcome;
  try { outcome = { ok: true, note: await run(looks) }; } catch (error) { outcome = { ok: false, reason: firstLine(error) }; }
  paid.push(...looks);
  checks.push({ step, ...outcome });
  say(`${checks.length} ${step}: ${outcome.ok ? `ok, ${outcome.note}` : `not ok, ${outcome.reason}`}${looks.length ? ` (${spend(looks)})` : ""}`);
}

try {
  await dir.file("letter-scan.pdf", await scanPdf((input, options) => sharp(input, options)));
  const lines = (page) => ["EXAMPLE WIDGETS LLC", `Statement, page ${page} of 2`, "", `Reference number: ${PAGE_IDS[page - 1]}`, "", "This is a synthetic test document."];
  await dir.file("statement.pdf", pdfBytes([{ lines: lines(1) }, { lines: lines(2) }]));
  const looking = host(true);
  say("pi-vision live eyes");
  say(`model: ${spec}${gateway ? ", through the gateway PI_VISION_LIVE_BASE_URL names" : ""}`);

  await check("scanned letter", async (looks) => {
    const read = await readAndFit(looking, { path: "letter-scan.pdf", ask: LETTER_ASK });
    looks.push(...read.paid);
    const answer = answerOf(read);
    if (!holds(answer, LETTER_ID)) throw new Error(`the eyes answered "${firstLine(answer)}", not ${LETTER_ID}`);
    return `read ${LETTER_ID} exactly`;
  });

  await check("page 2", async (looks) => {
    const read = await readAndFit(looking, { path: "statement.pdf", page: 2, ask: PAGE_ASK });
    looks.push(...read.paid);
    const answer = answerOf(read);
    if (holds(answer, PAGE_IDS[0])) throw new Error(`the eyes named page 1's ${PAGE_IDS[0]}: the read showed them another page`);
    if (!holds(answer, PAGE_IDS[1])) throw new Error(`the eyes answered "${firstLine(answer)}", not ${PAGE_IDS[1]}`);
    const pages = read.paid.map((r) => r.args.page);
    if (pages.some((page) => page !== 2)) throw new Error(`a receipt names page ${pages.join(", ")}, not 2`);
    return `named ${PAGE_IDS[1]}, which only page 2 holds`;
  });

  await check("receipts", async () => {
    if (!paid.length) throw new Error("no paid look was filed");
    for (const { facts } of paid) {
      if (facts.cost_usd === null) throw new Error(`a look cost null: pi-ai's catalog has no price for ${spec}`);
      if (typeof facts.cost_usd !== "number" || !(facts.cost_usd > 0)) throw new Error(`a paid look cost ${facts.cost_usd}, not a price above 0`);
      if (!(facts.tokens_in > 0 && facts.tokens_out > 0)) throw new Error(`a paid look has ${facts.tokens_in} tokens in and ${facts.tokens_out} out`);
    }
    const blind = await readAndFit(host(false), { path: "letter-scan.pdf", ask: LETTER_ASK });
    if (blind.misses.length !== 1 || blind.misses[0].code !== "no_vision_route") throw new Error(`the read with no eyes was heard as ${blind.misses.map((m) => m.code).join(", ") || "no miss"}, not one no_vision_route`);
    const [miss, ...more] = blind.looks;
    if (!miss || more.length || miss.status !== "failed" || miss.facts.cost_usd !== 0 || miss.facts.tokens_in !== 0 || miss.facts.tokens_out !== 0) {
      throw new Error(`the miss with no eyes filed ${JSON.stringify(blind.looks.map((r) => [r.status, r.facts.cost_usd, r.facts.tokens_in, r.facts.tokens_out]))}, not one failed look at $0 with 0 tokens`);
    }
    return `${paid.length} paid look${paid.length === 1 ? "" : "s"} priced with tokens; the miss with no eyes filed at $0 with 0 tokens`;
  });
} finally {
  await dir.remove();
}

const reads = checks.filter((c) => c.step !== "receipts");
say(`read rate: ${reads.filter((c) => c.ok).length} of ${reads.length} identifiers read exactly`);
say(`spend: ${spend(paid)}`);
const failed = checks.find((c) => !c.ok);
done(failed ? `not ok: ${failed.step}: ${failed.reason}` : "ok: pi-vision live eyes passed");
