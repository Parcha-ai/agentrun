// A faux System One service for rehearsals and tests: its default export is a fetch that answers `POST .../v1/systemone`
// as TypeSafe's Jev and OpenRouter's Decisions models do (JSON, or the multipart form a request with images is), and
// `GET .../v1/models` with a small Decisions catalog. A host points a provider's `fetch` option at it, as serve does under
// --faux with AGENTRUN_SERVE_FAUX_JEV or AGENTRUN_SERVE_FAUX_OPENROUTER. No request leaves the process.
//
// Answers are made up but stable: each is drawn from a hash of the model, the question and the state, so the same request
// answers the same, two models answer one question differently, and a map over 20 documents shows a spread. A noul
// question whose instructions or state hold "FAUX_NO" answers no, one holding "FAUX_YES" answers yes. Each call reports
// 120 input tokens per KB of state (at least 120), plus 800 per image, and a cost at OpenRouter's listed $0.02 per million
// input tokens for liquid/d1. Every faux answer's model ends in "(faux)".
//
// Environment, read per call:
//   AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS  base latency per call (default 150); each call adds up to as much again
//   AGENTRUN_FAUX_SYSTEM_ONE_STATUS    every call fails with this HTTP status, after it was received
//   AGENTRUN_FAUX_SYSTEM_ONE_FAIL      a substring: a call whose state holds it fails with HTTP 503 (an outcome_unknown)
//   AGENTRUN_FAUX_SYSTEM_ONE_CALLS     a file each call appends one JSON line to: path, model, question ids, image count
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

type Question = { type: string; instructions?: string; criteria?: unknown };
const PRICE_PER_TOKEN = 0.00000002;
/** The Decisions catalog the faux lists: a few models, with what each takes. */
const CATALOG = [
  { id: "~typesafe/jev-latest", input: ["text", "image"] },
  { id: "liquid/d1", input: ["text", "image"] },
  { id: "perplexity/pplx-decider-v1.2", input: ["text", "image"] },
  { id: "cloudflare/clef", input: ["text", "image"] },
  { id: "microsoft/microsoft-decision-1", input: ["text"] },
];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** A number in [0, 1) drawn from `parts`. */
const draw = (...parts: unknown[]): number => createHash("sha256").update(JSON.stringify(parts)).digest().readUInt32BE(0) / 2 ** 32;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** A distribution over `n` options that puts most of its mass on `top`. */
function distribution(n: number, top: number, sharpness: number): number[] {
  const rest = n > 1 ? (1 - sharpness) / (n - 1) : 0;
  const values = Array.from({ length: n }, (_, i) => round(i === top ? sharpness : rest));
  values[top] = round(1 - values.reduce((sum, v, i) => (i === top ? sum : sum + v), 0));
  return values;
}

function answer(question: Question, seed: unknown[], stateText: string): unknown {
  const p = draw(...seed);
  if (question.type === "choice") {
    const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>);
    const top = Math.floor(p * options.length);
    const sharpness = 0.55 + 0.4 * draw(...seed, "sharp");
    const probabilities = distribution(options.length, top, sharpness);
    return { type: "choice", choice: options[top], probabilities: Object.fromEntries(options.map((o, i) => [o, probabilities[i]])), confidence: round(sharpness) };
  }
  if (question.type === "score") {
    const levels = Array.isArray(question.criteria) ? question.criteria as unknown[] : [];
    const top = Math.floor(p * levels.length);
    const sharpness = 0.6 + 0.35 * draw(...seed, "sharp");
    const probabilities = distribution(levels.length, top, sharpness);
    const score = round(probabilities.reduce((sum, v, i) => sum + v * i, 0));
    return { type: "score", score, legend: Object.fromEntries(levels.map((l, i) => [i, String(l)])), probabilities: Object.fromEntries(probabilities.map((v, i) => [i, v])), confidence: round(sharpness) };
  }
  const text = `${question.instructions ?? ""} ${stateText}`;
  if (text.includes("FAUX_NO")) return { type: "noul", noul: round(0.04 + 0.1 * p) };
  if (text.includes("FAUX_YES")) return { type: "noul", noul: round(0.86 + 0.1 * p) };
  return { type: "noul", noul: round(0.03 + 0.94 * p) };
}

/** The request's JSON and its image count, from a JSON body (OpenRouter's: base64 `assets`) or the multipart form TypeSafe's SDK sends images in. */
async function readRequest(init: RequestInit): Promise<{ request: Record<string, unknown>; images: number }> {
  const headers = new Headers(init.headers);
  const body = init.body;
  if (body instanceof FormData || (headers.get("content-type") ?? "").startsWith("multipart/form-data") || body instanceof Blob) {
    const form = body instanceof FormData ? body : await new Response(body as BodyInit, { headers: { "content-type": headers.get("content-type") ?? "" } }).formData();
    const part = form.get("request");
    const request = JSON.parse(typeof part === "string" ? part : await (part as Blob).text()) as Record<string, unknown>;
    return { request, images: [...form.keys()].filter((name) => name !== "request").length };
  }
  const text = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : await new Response(body as BodyInit).text();
  const request = JSON.parse(text) as Record<string, unknown>;
  return { request, images: request.assets !== null && typeof request.assets === "object" ? Object.keys(request.assets).length : 0 };
}

export default async function fauxSystemOne(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if ((init.method ?? "GET").toUpperCase() === "GET" && url.pathname.endsWith("/v1/models")) {
    return json({ data: CATALOG.map((m) => ({ id: m.id, name: `${m.id} (faux)`, architecture: { input_modalities: m.input, output_modalities: ["decisions"] }, pricing: { prompt: String(PRICE_PER_TOKEN), completion: "0" } })) });
  }
  if (!url.pathname.endsWith("/v1/systemone")) return json({ error: { message: "not found" } }, 404);
  const { request, images } = await readRequest(init);
  const model = typeof request.model === "string" ? request.model : "jev-latest";
  const questions = (request.questions ?? {}) as Record<string, Question>;
  const stateText = JSON.stringify(request.state ?? null);
  // As OpenRouter does live: a model other than Jev reads an image only as a top-level item of an array state.
  const assets = request.assets !== null && typeof request.assets === "object" ? Object.keys(request.assets) : [];
  if (assets.length && !/^~?(typesafe\/)?jev-/.test(model) && !(Array.isArray(request.state) && assets.every((token) => (request.state as unknown[]).includes(token)))) {
    return json({ error: { message: `${model} reads images only as top-level state items; an image part nested in state or placed in a question's instructions or criteria would be sent as text`, code: 400 } }, 400);
  }
  if (process.env.AGENTRUN_FAUX_SYSTEM_ONE_CALLS) appendFileSync(process.env.AGENTRUN_FAUX_SYSTEM_ONE_CALLS, `${JSON.stringify({ pid: process.pid, path: url.pathname, model, questions: Object.keys(questions), images })}\n`);
  const base = Number(process.env.AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS ?? 150);
  if (base > 0) await sleep(Math.round(base * (1 + draw(model, stateText, "latency"))), undefined, init.signal ? { signal: init.signal } : undefined);
  const failWith = Number(process.env.AGENTRUN_FAUX_SYSTEM_ONE_STATUS);
  if (failWith) return json({ error: { message: "faux failure" } }, failWith);
  const failOn = process.env.AGENTRUN_FAUX_SYSTEM_ONE_FAIL;
  if (failOn && stateText.includes(failOn)) return json({ error: { message: "faux unavailable" } }, 503);
  const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answer(q, [model, id, q.instructions, stateText], stateText)]));
  const inputTokens = Math.max(120, Math.round(120 * Buffer.byteLength(stateText) / 1024)) + 800 * images;
  return json({ id: `faux-${createHash("sha256").update(model + stateText).digest("hex").slice(0, 16)}`, model: `${model} (faux)`, answers,
    usage: { input_tokens: inputTokens, output_tokens: 0, cost: inputTokens * PRICE_PER_TOKEN } });
}
