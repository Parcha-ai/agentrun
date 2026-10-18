// The live Jev check: `vision.judge` from the built package against real Jev, through the port `@parcha/agentrun-jev`'s
// `createJevRunner` returns, the path no fake covers. Not part of `npm test`: it needs a key and spends a fraction of a
// cent. From the repository root, after `npm ci --ignore-scripts && npm run build`, with the key in TYPESAFE_API_KEY:
//   node packages/pi-vision/test/live/jev.mjs
// Four checks on images it draws: a known target found by a box (overlap with the truth at least 0.5) beside a presence
// noul, and an absent target's noul low; two shapes classified by example images in the criteria; every answer priced;
// a box asked of Jev 1.13 refused before any request. The last stdout line is `ok: pi-vision live jev passed` or
// `not ok: <step>: <reason>`. Nothing printed carries the key.

const done = (line) => { console.log(line); process.exit(line.startsWith("ok:") ? 0 : 1); };
const firstLine = (value) => String(value?.message ?? value).split("\n")[0].slice(0, 300);
if (!process.env.TYPESAFE_API_KEY?.trim()) done("not ok: preflight: TYPESAFE_API_KEY is not set");
let loaded;
try {
  loaded = await Promise.all([import("@parcha/agentrun-jev"), import("@parcha/pi-vision/durable"), import("@parcha/pi-vision/node"), import("@parcha/pi-vision/testing"), import("sharp")]);
} catch (error) {
  done(`not ok: preflight: ${firstLine(error)}; run npm ci --ignore-scripts && npm run build from the repository root`);
}
const [{ createJevRunner }, { createVisionExtension }, { nodeVisionEnv }, { fixtureDir }, { default: sharp }] = loaded;

const PRICE = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 };
const filed = [];
const vision = (model) => createVisionExtension({
  jev: { judge: createJevRunner({ pricing: PRICE }), ...(model ? { model } : {}) },
  evidence: { file: async (_label, record) => { filed.push(record); return null; } },
  scope: () => ({ label: "live-jev", deriveDir: "derived" }),
});
const call = { conversationId: "live-jev", callId: "1", model: undefined, signal: undefined };
const checks = [];
async function check(step, run) {
  let outcome;
  try { outcome = { ok: true, note: await run() }; } catch (error) { outcome = { ok: false, reason: firstLine(error) }; }
  checks.push({ step, ...outcome });
  console.log(`${checks.length} ${step}: ${outcome.ok ? `ok, ${outcome.note}` : `not ok, ${outcome.reason}`}`);
}

const dir = await fixtureDir("pi-vision-live-jev-");
const grey = (w, h, shapes) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 128, g: 128, b: 128 } } }).composite(shapes).png().toBuffer();
const square = async (size, color) => ({ input: await sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer() });
const disc = async (size, color) => ({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="rgb(${color.r},${color.g},${color.b})"/></svg>`) });
const BLUE = { r: 20, g: 40, b: 220 }, RED = { r: 220, g: 30, b: 30 };
await dir.file("scene.png", await grey(1200, 800, [{ ...(await square(200, BLUE)), left: 700, top: 200 }]));
await dir.file("ex-square.png", await grey(600, 400, [{ ...(await square(160, BLUE)), left: 220, top: 120 }]));
await dir.file("ex-disc.png", await grey(600, 400, [{ ...(await disc(160, RED)), left: 220, top: 120 }]));
await dir.file("a.png", await grey(800, 600, [{ ...(await disc(240, RED)), left: 80, top: 300 }]));
await dir.file("b.png", await grey(800, 600, [{ ...(await square(120, BLUE)), left: 600, top: 60 }]));
const env = nodeVisionEnv({ cwd: dir.path });
const judge = (request, model) => vision(model).judge(env, call).execute(request);

await check("box", async () => {
  const { answers } = await judge({ paths: ["scene.png"], questions: {
    present: { type: "noul", instructions: "Is there a blue square in `images[0].image`?" },
    absent: { type: "noul", instructions: "Is there a red circle in `images[0].image`?" },
    where: { type: "box", instructions: "the blue square in `images[0].image`" },
  } });
  const [x, y, w, h] = answers.where.fragment.split("percent:")[1].split(",").map(Number);
  const truth = { x: (700 / 1200) * 100, y: 25, w: (200 / 1200) * 100, h: 25 };
  const overlap = Math.max(0, Math.min(x + w, truth.x + truth.w) - Math.max(x, truth.x)) * Math.max(0, Math.min(y + h, truth.y + truth.h) - Math.max(y, truth.y));
  const iou = overlap / (w * h + truth.w * truth.h - overlap);
  if (!(iou >= 0.5)) throw new Error(`the box ${answers.where.fragment} overlaps the truth by ${iou.toFixed(3)}`);
  if (!(answers.present.noul > 0.5 && answers.absent.noul < 0.5)) throw new Error(`present ${answers.present.noul}, absent ${answers.absent.noul}`);
  return `IoU ${iou.toFixed(3)} (confidence ${answers.where.confidence}), present ${answers.present.noul.toFixed(2)}, absent ${answers.absent.noul.toFixed(2)}`;
});

await check("by example", async () => {
  const got = [];
  for (const file of ["a.png", "b.png"]) {
    const { answers } = await judge({ paths: [file], examples: { "<square>": "ex-square.png", "<disc>": "ex-disc.png" }, questions: { shape: { type: "choice", instructions: "Which shape is in `images[0].image`?", criteria: { square: "A blue square, like <square>", disc: "A red disc, like <disc>" } } } });
    got.push(answers.shape.choice);
  }
  if (got.join() !== "disc,square") throw new Error(`classified ${got.join(", ")}, not disc, square`);
  return "a.png disc, b.png square";
});

await check("prices", async () => {
  const paid = filed.filter((r) => r.status === "ok");
  if (paid.length !== 3 || paid.some((r) => !(r.facts.cost_usd > 0) || !(r.facts.tokens_in > 0))) throw new Error(`filed ${JSON.stringify(paid.map((r) => [r.facts.cost_usd, r.facts.tokens_in]))}`);
  return `3 judgments, $${paid.reduce((sum, r) => sum + r.facts.cost_usd, 0).toFixed(6)}, ${paid.map((r) => r.facts.tokens_in).join("/")} tokens in`;
});

await check("box on 1.13", async () => {
  const before = filed.length;
  const message = await judge({ paths: ["scene.png"], questions: { where: { type: "box", instructions: "the blue square" } } }, "jev-latest").then(() => "answered", (error) => error.message);
  if (!message.startsWith("unsupported:") || filed.at(-1)?.facts.cost_usd !== 0 || filed.length !== before + 1) throw new Error(`a box of jev-latest gave "${message}"`);
  return "refused before any request, an unsupported miss at $0";
});

try { await dir.remove(); } catch (error) { checks.push({ step: "cleanup", ok: false, reason: firstLine(error) }); }
const failed = checks.find((c) => !c.ok);
done(failed ? `not ok: ${failed.step}: ${failed.reason}` : "ok: pi-vision live jev passed");
