// A free local model on the owner's own machine: what the machine is (platform, arch, memory, GPU) and its Ollama, the
// model this server recommends for it (recommendLocalModel, a pure function of those facts), and one pull of it at a time
// through that Ollama, its progress on the read surface (GET /settings/local-model). A pull is only ever of a tag the
// recommendation can name (LOCAL_MODEL_TAGS), and only where the Ollama here is the owner's own: one owner's own server on
// their own machine (server.ts whyNotOwnMachine, the rule ollama-provider.ts ollamaHostOf names the default address by),
// never under the faux model or a model gateway (model.ts asksOllama). Once a pull ends, the kept listing is dropped
// (ollamaForget), so the model is in the picker at once.
import { execFile } from "node:child_process";
import { arch, platform, totalmem } from "node:os";
import { ApiError } from "./errors.js";
import { isLoopbackName } from "./host-check.js";
import { asksOllama, FAUX_ENV } from "./model.js";
import { ollamaBase, ollamaModels, ollamaPull, type OllamaPullLine, ollamaVersion } from "./ollama-provider.js";
import { logLine } from "./print.js";
import { registerSecretPage, registerSecretWrite } from "./secret-writes.js";
import { isObject, unknownFields } from "./validate.js";

// Owner-only: the machine's facts are the owner's, and a pull spends their disk and bandwidth.
for (const operation of ["getLocalModel", "pullLocalModel"]) registerSecretWrite(operation, () => true);
registerSecretPage(["getLocalModel", "pullLocalModel"], "/#/");

/** The GPU where it is cheap to read: Apple silicon's unified memory (darwin on arm64), an NVIDIA card as nvidia-smi names
 *  it, else unknown. */
export type Gpu = { readonly kind: "apple"; readonly unified: true } | { readonly kind: "nvidia"; readonly name: string; readonly memory_bytes: number } | { readonly kind: "unknown" };
/** What this machine is. */
export type Machine = { readonly platform: string; readonly arch: string; readonly ram_bytes: number; readonly gpu: Gpu };
/** The Ollama here: whether this server asks one at all (never under the faux model or a model gateway, model.ts
 *  asksOllama), whether it answered, and the version it says. */
export type OllamaFacts =
  | { readonly asked: false; readonly reachable: false; readonly version: null }
  | { readonly asked: true; readonly reachable: false; readonly version: null }
  | { readonly asked: true; readonly reachable: true; readonly version: string };
/** Everything the recommendation reads: the machine, its Ollama, and the tags that Ollama has pulled. */
export type LocalFacts = { readonly machine: Machine; readonly ollama: OllamaFacts; readonly pulled: readonly string[] };
/** The model recommended here, and why in words; `tag` null where none fits, and the words say what to do instead. */
export type Recommendation = { readonly tag: string; readonly why: string; readonly pulled: boolean } | { readonly tag: null; readonly why: string; readonly pulled: false };

/** The non-Apple pick, and Apple's where Inkling does not run: one line. A measurement (qwen3:8b against qwen3:30b-a3b,
 *  through this server's own runs) sets it. */
export const QWEN3_DEFAULT = "qwen3:8b";
/** Apple silicon's pick, where its Ollama runs it (MLX, on Apple silicon alone). */
export const INKLING = "inkling-2-mini";
/** The first Ollama that runs INKLING. */
export const INKLING_OLLAMA = "0.40.17";
/** Where Ollama is installed from. */
export const OLLAMA_DOWNLOAD = "https://ollama.com/download";

const GIB = 1024 ** 3;
/** The least memory (total RAM; Apple silicon's unified memory) each tag is offered on, in GiB: its weights at Ollama's
 *  default quantization, the KV cache of the context this server asks (ollama-provider.ts contextOf), and room for the
 *  system. A machine sold as 16 GB reads about 15.5 GiB, so each floor sits under the size it is meant for. */
export const RAM_FLOOR_GIB: Readonly<Record<string, number>> = {
  [INKLING]: 15,
  "qwen3:30b-a3b": 30,
  "qwen3:8b": 15,
  "qwen3:4b": 11,
};
/** The qwen3 tags, largest first: the pick is QWEN3_DEFAULT, else the next smaller that fits. */
const QWEN3_LADDER = ["qwen3:30b-a3b", "qwen3:8b", "qwen3:4b"] as const;
const QWEN3_FITS = QWEN3_LADDER.slice(Math.max(0, QWEN3_LADDER.indexOf(QWEN3_DEFAULT as (typeof QWEN3_LADDER)[number])));
/** Every tag the recommendation can name, and so the only tags a pull here takes. */
export const LOCAL_MODEL_TAGS: readonly string[] = Object.freeze([INKLING, ...QWEN3_FITS]);

/** A tag as Ollama lists it: with no `:`, `:latest`. */
export const fullTag = (tag: string): string => (tag.includes(":") ? tag : `${tag}:latest`);
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;
const fits = (machine: Machine, tag: string): boolean => machine.ram_bytes >= (RAM_FLOOR_GIB[tag] ?? Infinity) * GIB;
const needs = (tag: string): string => `${tag} needs ${RAM_FLOOR_GIB[tag]} GiB of memory`;

/** `version` at or past `floor`, both dotted numbers (a suffix such as `-rc1` ignored); an unreadable version is not. */
export function versionAtLeast(version: string, floor: string): boolean {
  const parts = (text: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim())?.slice(1).map(Number);
  const [have, want] = [parts(version), parts(floor)];
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i]! > want[i]!;
  return true;
}

/** Whether this machine is Apple silicon. */
const appleSilicon = (machine: Machine): boolean => machine.gpu.kind === "apple";

/**
 * The model this server recommends for `facts`, and why. No Ollama: none, and where to install it. Apple silicon with an
 * Ollama at INKLING_OLLAMA or later and the memory for it: INKLING. Everyone else: QWEN3_DEFAULT, or the next smaller qwen3
 * that fits in memory, or none, saying what each needs; Apple silicon on an older Ollama is told to update for INKLING. A
 * tag already pulled says so: no pull needed.
 */
export function recommendLocalModel(facts: LocalFacts): Recommendation {
  const { machine, ollama } = facts;
  if (!ollama.asked) return { tag: null, why: "This server asks no Ollama.", pulled: false };
  if (!ollama.reachable) return { tag: null, why: `Ollama isn't running on this machine. Install it from ${OLLAMA_DOWNLOAD}, start it, then come back here.`, pulled: false };
  const has = new Set(facts.pulled.map(fullTag));
  const done = (tag: string, why: string): Recommendation => (has.has(fullTag(tag)) ? { tag, why: `${why} Already pulled: no pull needed.`, pulled: true } : { tag, why, pulled: false });
  const apple = appleSilicon(machine);
  const inklingRuns = apple && versionAtLeast(ollama.version, INKLING_OLLAMA);
  if (inklingRuns && fits(machine, INKLING)) return done(INKLING, `Apple silicon with Ollama ${ollama.version} runs ${INKLING}; ${needs(INKLING)}, and this Mac has ${gib(machine.ram_bytes)}.`);
  const notes = [
    ...(apple && !inklingRuns ? [`Update Ollama to ${INKLING_OLLAMA} for ${INKLING}.`] : []),
    ...(inklingRuns ? [`${needs(INKLING)}, and this Mac has ${gib(machine.ram_bytes)}.`] : []),
  ];
  const tag = QWEN3_FITS.find((candidate) => fits(machine, candidate));
  if (!tag) {
    const least = QWEN3_FITS[QWEN3_FITS.length - 1]!;
    return { tag: null, why: [`This machine has ${gib(machine.ram_bytes)} of memory, and the smallest local model offered here, ${needs(least)}. Add a model key instead.`, ...notes].join(" "), pulled: false };
  }
  const smaller = tag === QWEN3_DEFAULT ? "" : ` ${needs(QWEN3_DEFAULT)}, so the smaller ${tag}.`;
  return done(tag, [`${tag} fits this machine's ${gib(machine.ram_bytes)} of memory (it needs ${RAM_FLOOR_GIB[tag]} GiB).${smaller}`, ...notes].join(" "));
}

// ---- the machine ------------------------------------------------------------------------------------------------------

/** How long nvidia-smi is waited for. */
export const NVIDIA_SMI_TIMEOUT_MS = 2_000;

/** The first GPU nvidia-smi names (`name, memory.total` in MiB), or unknown where it is not there, fails or is slow. */
async function nvidiaGpu(): Promise<Gpu> {
  const out = await new Promise<string | undefined>((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: NVIDIA_SMI_TIMEOUT_MS, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout));
  });
  return nvidiaOf(out);
}

/** nvidia-smi's first line, `<name>, <MiB>`, as a GPU; unknown for anything else. */
export function nvidiaOf(out: string | undefined): Gpu {
  const line = out?.split("\n").map((text) => text.trim()).find(Boolean);
  const match = line ? /^(.+?),\s*(\d+)(?:\s*MiB)?$/.exec(line) : null;
  return match ? { kind: "nvidia", name: match[1]!.trim().slice(0, 200), memory_bytes: Number(match[2]) * 1024 ** 2 } : { kind: "unknown" };
}

/** This machine, read once: what a server serves for its life. A test hands its own (ServeOptions.machine). */
export async function readMachine(): Promise<Machine> {
  const [os, cpu] = [platform(), arch()];
  const gpu: Gpu = os === "darwin" && cpu === "arm64" ? { kind: "apple", unified: true } : await nvidiaGpu();
  return { platform: os, arch: cpu, ram_bytes: totalmem(), gpu };
}

// ---- the pull ---------------------------------------------------------------------------------------------------------

/** The pull here, as the read surface shows it. */
export type PullView = { tag: string; state: "pulling" | "done" | "failed"; status: string; completed_bytes: number; total_bytes: number; error?: string };

/** One pull at a time, through `pull`; `finished` once it succeeds (the listing dropped and read again), before it reads
 *  done. A log line at its start, its end and its failure: the tag, the bytes and the milliseconds, nothing else. */
export function localPulls({ pull, finished, log, signal }: { pull: (tag: string, onLine: (line: OllamaPullLine) => void, signal: AbortSignal) => Promise<void>; finished: (tag: string) => Promise<void>; log?: (line: string) => void; signal: AbortSignal }) {
  let current: PullView | undefined;
  return {
    view: (): PullView | null => (current ? { ...current } : null),
    pulling: (): boolean => current?.state === "pulling",
    /** Starts pulling `tag` (checked by the caller), behind the answer. */
    start(tag: string): PullView {
      const layers = new Map<string, { total: number; completed: number }>();
      const mine: PullView = { tag, state: "pulling", status: "starting", completed_bytes: 0, total_bytes: 0 };
      current = mine;
      const started = performance.now();
      log?.(logLine("local_model_pull_start", { tag }));
      const onLine = (line: OllamaPullLine) => {
        mine.status = line.status.slice(0, 200);
        if (line.digest && line.total !== undefined) {
          layers.set(line.digest, { total: line.total, completed: Math.min(line.completed ?? 0, line.total) });
          mine.total_bytes = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
          mine.completed_bytes = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0);
        }
      };
      void pull(tag, onLine, signal)
        .then(() => finished(tag))
        .then(() => {
          Object.assign(mine, { state: "done", status: "success", completed_bytes: mine.total_bytes });
          log?.(logLine("local_model_pull_end", { tag, bytes: mine.total_bytes, ms: Math.round(performance.now() - started) }));
        })
        .catch((error: unknown) => {
          Object.assign(mine, { state: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
          log?.(logLine("local_model_pull_failed", { tag, bytes: mine.completed_bytes, ms: Math.round(performance.now() - started) }));
        });
      return { ...mine };
    },
  };
}
export type LocalPulls = ReturnType<typeof localPulls>;

// ---- the route --------------------------------------------------------------------------------------------------------

/** Whether the Ollama `env` names is on another machine: OLLAMA_HOST names an address that is not this machine's own
 *  (a loopback name). This server reads only its own memory and GPU, so it recommends and pulls nothing for that one. An
 *  address the base rule refuses is no Ollama asked at all, and not said to be elsewhere. */
export function ollamaElsewhere(env: NodeJS.ProcessEnv): boolean {
  if (!env.OLLAMA_HOST?.trim()) return false;
  try {
    return !isLoopbackName(new URL(ollamaBase(env)).hostname);
  } catch {
    return false;
  }
}

/** The words for an Ollama on another machine (ollamaElsewhere), which never name its address. */
export const OLLAMA_ELSEWHERE = "The Ollama OLLAMA_HOST names is on another machine, and this server reads only its own memory and GPU, so it recommends and pulls no model for that one. Pull one where that Ollama runs: ollama pull <tag>.";

/** Why no pull is made through the Ollama `env` names, in words, or undefined where one may: the faux model or a model
 *  gateway takes every model here (asksOllama); a server that is not one owner's own on their own machine (`notOwn`,
 *  server.ts whyNotOwnMachine's reasons) pulls nothing into an Ollama that is not theirs. */
export function pullRefusal(env: NodeJS.ProcessEnv, notOwn: readonly string[]): string | undefined {
  if (env[FAUX_ENV]) return "This server runs the faux model, so no local model is pulled here.";
  if (!asksOllama(env)) return "This server sends every model to its model gateway (AGENT_MODEL_BASE_URL), so a local model would not run here.";
  if (notOwn.length) return `A local model is pulled from here only on one owner's own server on their own machine, and this server ${notOwn.join("; ")}. Pull it where Ollama runs: ollama pull <tag>.`;
  if (!env.OLLAMA_HOST?.trim()) return "No Ollama is asked here.";
  if (ollamaElsewhere(env)) return OLLAMA_ELSEWHERE;
  return undefined;
}

/** What GET /settings/local-model and POST /settings/local-model/pull read. */
export type LocalModelDeps = { env: NodeJS.ProcessEnv; notOwn: readonly string[]; machine: () => Promise<Machine>; pulls: LocalPulls };

/** The read surface: the machine, its Ollama, the recommendation, the pull here, and whether a pull may be made. */
export async function localModelView({ env, notOwn, machine, pulls }: LocalModelDeps) {
  const refused = pullRefusal(env, notOwn);
  const asked = asksOllama(env);
  const [facts, version, listed] = await Promise.all([machine(), asked ? ollamaVersion(env) : undefined, asked ? ollamaModels(env) : []]);
  const ollama: OllamaFacts = !asked ? { asked: false, reachable: false, version: null } : version === undefined ? { asked: true, reachable: false, version: null } : { asked: true, reachable: true, version };
  // An Ollama on another machine is not this machine's: no recommendation from this machine's memory and GPU for it.
  const recommended: Recommendation = asked && ollamaElsewhere(env) ? { tag: null, why: OLLAMA_ELSEWHERE, pulled: false }
    : recommendLocalModel({ machine: facts, ollama, pulled: listed.map((model) => model.name) });
  // Not asked, the refusal is the only word on it: never that Ollama isn't running.
  return { machine: facts, ollama, recommended: asked || !refused ? recommended : { ...recommended, why: refused }, pull: pulls.view(), can_pull: refused === undefined, refused: refused ?? null };
}

/** POST /settings/local-model/pull: `{ tag }`, one of LOCAL_MODEL_TAGS (422 otherwise), where a pull may be made (403 in
 *  words otherwise), none under way (409 local_model_pulling). Answers the read surface with the pull started. */
export async function pullLocalModel(deps: LocalModelDeps, body: unknown) {
  if (!isObject(body) || typeof body.tag !== "string") throw new ApiError("input_invalid", "Name the tag to pull: { \"tag\": \"<tag>\" }.", { fields: [{ field: "tag", reason: "missing", message: "required, a string" }] });
  const extra = unknownFields(body, ["tag"]);
  if (extra.length) throw new ApiError("input_invalid", extra.map((issue) => issue.message).join(" "), { fields: extra });
  if (!LOCAL_MODEL_TAGS.includes(body.tag)) throw new ApiError("input_invalid", `Only the tags this server recommends are pulled from here: ${LOCAL_MODEL_TAGS.join(", ")}.`, { fields: [{ field: "tag", reason: "not_an_option", message: `one of ${LOCAL_MODEL_TAGS.join(", ")}` }] });
  const refused = pullRefusal(deps.env, deps.notOwn);
  if (refused) throw new ApiError("forbidden", refused);
  if (deps.pulls.pulling()) throw new ApiError("local_model_pulling", `A pull of ${deps.pulls.view()?.tag} is under way here: one at a time. Its progress is on GET /settings/local-model.`);
  deps.pulls.start(body.tag);
  return localModelView(deps);
}

/** The real pull: through the Ollama `env` names (ollama-provider.ts ollamaPull). */
export const pullThrough = (env: () => NodeJS.ProcessEnv, stallMs?: number) => (tag: string, onLine: (line: OllamaPullLine) => void, signal: AbortSignal) => ollamaPull(env(), tag, onLine, { signal, ...(stallMs !== undefined ? { stallMs } : {}) });
