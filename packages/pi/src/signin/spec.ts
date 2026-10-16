// What a demo needs, and the key check that runs before anything else. Neither check sends a request or prompts. They
// read only the environment they are given, the PATH in it and the demo's own node_modules, and the key check runs one
// process: `<cmd> --version`, for a program with a minimum version. A key's value is never read past "is it set", and
// never printed.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";

/** A run mode an item is needed for: `live` (paid calls) or `kill` (the kill on a real box). Without `for`, every run. */
export type RunMode = "live" | "kill";
export type Platform = "linux" | "darwin" | "win32";
export type Key = { env: string; why: string; where: string; required: boolean; for?: RunMode };
/** `min` is an x.y.z version, compared with the first x.y.z that `<cmd> --version` prints. */
export type Program = { cmd: string; why: string; required: boolean; platforms?: Platform[]; min?: string; for?: RunMode };
/** An npm package the demo loads only when used, installed with `--no-save` so it is never a dependency. */
export type Package = { name: string; version: string; why: string; required: boolean; for?: RunMode };
/** One of its members; an array member means all of its items (a key pair, or a key with its package). */
export type Choice = { oneOf: Array<Key | Program | Package | Array<Key | Program | Package>>; why: string; for?: RunMode };
export type ModelNeed = "text" | "tools" | "images";
export type EyesNeed = "images" | "video";
export type DemoSpec = {
  name: string;
  models: {
    lead: { needs: ModelNeed[]; default?: string };
    /** A second model the run calls itself. */
    eyes?: { needs: EyesNeed[]; default?: string };
    judge?: { jev: true };
  };
  keys: Array<Key | Choice>;
  programs: Array<Program | Choice>;
  packages?: Array<Package | Choice>;
  expectedCalls: number;
  /** USD for one `--live` run. */
  expectedCost: number;
};

/** Jev in a stranger's run: its own key, or Jev through OpenRouter. Nothing is substituted silently. */
export const JEV_KEYS: Choice = {
  oneOf: [
    { env: "TYPESAFE_API_KEY", why: "Jev's typed judgments", where: "https://console.typesafe.ai/keys", required: true },
    { env: "OPENROUTER_API_KEY", why: "Jev through OpenRouter", where: "https://openrouter.ai/keys", required: true },
  ],
  why: "the judge is Jev",
  for: "live",
};

export type CheckOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The demo's directory, where its packages resolve from. Default: the current directory. */
  dir?: string;
  live?: boolean;
  kill?: boolean;
  /** An explicit eyes model (`--eyes-model`); its key is checked when the model is resolved. */
  eyes?: { provider: string; model: string };
};

/** One requirement of this run and whether this machine meets it. `fix` says what to do, never a value. */
export type ReportItem = { kind: "key" | "program" | "package" | "choice" | "model"; name: string; why: string; required: boolean; met: boolean; fix?: string };
export type KeyReport = {
  ok: boolean;
  /** 2 when a required item is missing: nothing may start. */
  exitCode: 0 | 2;
  items: ReportItem[];
  missing: ReportItem[];
  expectedCalls: number;
  expectedCost: number;
  /** The report as printed: every requirement, what is missing and how to fix it. */
  text: string;
};

type Member = Key | Program | Package;
const isChoice = (item: Member | Choice): item is Choice => "oneOf" in item;
const isKey = (item: Member): item is Key => "env" in item;
const isProgram = (item: Member): item is Program => "cmd" in item;
const nameOf = (item: Member) => isKey(item) ? item.env : isProgram(item) ? item.cmd : `${item.name}@${item.version}`;

/** Every requirement of `spec`, the implied ones included: Jev's keys when the judge is Jev. */
function requirements(spec: DemoSpec): Array<Member | Choice> {
  return [...spec.keys, ...(spec.models.judge?.jev ? [JEV_KEYS] : []), ...spec.programs, ...(spec.packages ?? [])];
}

type Ctx = { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; dir: string };

/** The file `cmd` runs from `env`'s PATH, or undefined when it is not there. */
function onPath(cmd: string, ctx: Ctx): string | undefined {
  const exts = ctx.platform === "win32" ? ["", ...(ctx.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (ctx.env.PATH ?? ctx.env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, cmd + ext);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      } catch { /* not this one */ }
    }
  }
  return undefined;
}

const XYZ = /(\d+)\.(\d+)\.(\d+)/;
const versionParts = (version: string) => XYZ.exec(version)?.slice(1, 4).map(Number);

/** The first x.y.z that `file --version` prints, stdout before stderr; undefined when it prints none, fails or hangs. */
function programVersion(file: string, ctx: Ctx): string | undefined {
  const shell = ctx.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const run = spawnSync(file, ["--version"], { env: ctx.env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], shell });
  return run.status === 0 ? XYZ.exec(`${run.stdout}\n${run.stderr}`)?.[0] : undefined;
}

/** Whether x.y.z `found` is at least `min`. */
function atLeast(found: string, min: string): boolean {
  const [a, b] = [versionParts(found)!, versionParts(min)!];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** The version of `name` that Node would load from `dir`, or undefined when it resolves nowhere. */
function installedVersion(name: string, dir: string): string | undefined {
  for (const base of createRequire(join(dir, "noop.js")).resolve.paths(name) ?? []) {
    const manifest = join(base, name, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      return String(JSON.parse(readFileSync(manifest, "utf8")).version);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether `item` is met here, and the fix when it is not. */
function checkMember(item: Member, ctx: Ctx): { met: boolean; fix?: string } {
  if (isKey(item)) return ctx.env[item.env] ? { met: true } : { met: false, fix: `set ${item.env} (create it: ${item.where})` };
  if (isProgram(item)) {
    if (item.platforms && !item.platforms.includes(ctx.platform as Platform)) {
      return { met: false, fix: `${item.cmd} runs on ${item.platforms.join(" or ")} only; this machine is ${ctx.platform}` };
    }
    const file = onPath(item.cmd, ctx);
    if (!file) return { met: false, fix: `install ${item.cmd}${item.min ? ` ${item.min} or later` : ""}; it is not on PATH` };
    if (!item.min) return { met: true };
    if (!versionParts(item.min)) return { met: false, fix: `the spec's minimum for ${item.cmd} (${item.min}) is not an x.y.z version` };
    const found = programVersion(file, ctx);
    if (!found) return { met: false, fix: `${item.cmd} --version printed no x.y.z version, so ${item.min} or later cannot be confirmed` };
    return atLeast(found, item.min) ? { met: true } : { met: false, fix: `${item.cmd} is ${found}; this run needs ${item.min} or later` };
  }
  const found = installedVersion(item.name, ctx.dir);
  if (found === item.version) return { met: true };
  const install = `npm install --no-save ${item.name}@${item.version}`;
  return { met: false, fix: found === undefined ? install : `${install} (found ${found})` };
}

const applies = (item: { for?: RunMode }, options: CheckOptions) => !item.for || (item.for === "live" ? options.live || options.kill : options.kill) === true;

/**
 * What this demo needs for this run, and what is missing. Items whose `for` is not this run's mode are left out, choice
 * members included; `kill` implies `live`. A choice is met by any member, an array member only when all of its items
 * are. A relative `dir` is taken from the current directory. A required program
 * outside its platforms is missing, before anything starts, and so is one below its `min` or whose version cannot be
 * read. It sends no request and prompts for nothing, so a run that checks first sends nothing while a required item is
 * missing (`exitCode` 2).
 */
export function checkKeys(spec: DemoSpec, options: CheckOptions = {}): KeyReport {
  const ctx: Ctx = { env: options.env ?? process.env, platform: options.platform ?? process.platform, dir: resolve(options.dir ?? ".") };
  const items: ReportItem[] = [];
  for (const item of requirements(spec)) {
    if (!applies(item, options)) continue;
    if (!isChoice(item)) {
      const kind = isKey(item) ? "key" : isProgram(item) ? "program" : "package";
      items.push({ kind, name: nameOf(item), why: item.why, required: item.required, ...checkMember(item, ctx) });
      continue;
    }
    // A member's own `for` applies too: an item this mode does not need drops out of its member, and a member left with
    // nothing drops out of the choice, which this mode then does not need at all.
    const members = item.oneOf.map((member) => (Array.isArray(member) ? member : [member]).filter((one) => applies(one, options))).filter((all) => all.length);
    if (!members.length) continue;
    const options_ = members.map((all) => {
      const checked = all.map((one) => ({ one, ...checkMember(one, ctx) }));
      return { name: all.map(nameOf).join(" + "), met: checked.every((one) => one.met), fixes: checked.filter((one) => !one.met).map((one) => one.fix) };
    });
    const met = options_.some((option) => option.met);
    items.push({
      kind: "choice", name: options_.map((option) => option.name).join(" or "), why: item.why, required: true, met,
      ...(met ? {} : { fix: `one of: ${options_.map((option) => option.fixes.join(", ")).join("; or ")}` }),
    });
  }
  const eyes = spec.models.eyes;
  if (eyes && (options.live || options.kill) && eyes.needs.includes("video") && !options.eyes) {
    items.push({
      kind: "model", name: "eyes", why: "the run's eyes read video", required: true, met: false,
      fix: "the ChatGPT plan takes no video input, and the lead model's catalog lists none; name a model that reads video natively with --eyes-model and set its provider's key, or list images and let frames be extracted locally",
    });
  }
  const missing = items.filter((item) => item.required && !item.met);
  const mode = options.kill ? "--live --kill" : options.live ? "--live" : "on fakes";
  const lines = [`${spec.name} (${mode}) needs:`];
  for (const item of items) {
    const state = item.met ? "ok      " : item.required ? "MISSING " : "optional";
    lines.push(`  ${state} ${item.kind} ${item.name}: ${item.why}`);
    if (!item.met) lines.push(`           ${item.fix}`);
  }
  if (options.live || options.kill) {
    lines.push("  model: Sign in with ChatGPT (your plan pays), or --provider and --model with that provider's key");
    lines.push(`Expected: about ${spec.expectedCalls} model calls, about $${spec.expectedCost.toFixed(2)} at list prices.`);
  }
  lines.push(missing.length
    ? `${missing.length} required ${missing.length === 1 ? "item is" : "items are"} missing, so nothing started. SETUP-PROMPT.md beside this demo walks through each one.`
    : "Everything this run needs is here.");
  return { ok: missing.length === 0, exitCode: missing.length ? 2 : 0, items, missing, expectedCalls: spec.expectedCalls, expectedCost: spec.expectedCost, text: lines.join("\n") };
}

/** An UPPER_SNAKE name that reads as a credential: `*_API_KEY`, `*_KEY`, `*_TOKEN*`, `*_SECRET*`, `*_PROJECT_ID`. */
const CREDENTIAL = /_(API_)?KEY$|_TOKEN|_SECRET|_PROJECT_ID$/;
const ENV_NAME = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_])/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `name` as a whole word: not part of a longer name, a path, or a hyphenated command. */
const mentions = (text: string, name: string) => new RegExp(`(?<![A-Za-z0-9_@/.-])${escape(name)}(?![A-Za-z0-9_/-])`).test(text);

export type SetupPromptReport = {
  ok: boolean;
  /** Spec names the prompt never mentions: key env names, program commands and package names, choice members included. */
  missing: string[];
  /** Credential env names the prompt mentions that the spec does not list. */
  extra: string[];
};

/**
 * Whether a demo's SETUP-PROMPT.md matches its spec. Every key env name, program command and package name in the spec,
 * choice members included, appears in the prompt. "Nothing more" covers credential env names only: an UPPER_SNAKE name
 * that reads as a credential and is not in the spec fails. A prompt's own command words (sudo, an install step) are
 * never read as programs.
 */
export function checkSetupPrompt(spec: DemoSpec, text: string): SetupPromptReport {
  const members = requirements(spec).flatMap((item) => isChoice(item) ? item.oneOf.flat() : [item]);
  const names = members.map((item) => isKey(item) ? item.env : isProgram(item) ? item.cmd : item.name);
  const envs = new Set(members.filter(isKey).map((item) => item.env));
  const missing = [...new Set(names)].filter((name) => !mentions(text, name));
  const extra = [...new Set(text.match(ENV_NAME) ?? [])].filter((name) => CREDENTIAL.test(name) && !envs.has(name));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}
